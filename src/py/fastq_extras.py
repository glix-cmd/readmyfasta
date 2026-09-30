# Métricas avanzadas de FASTQ para READMYFASTA.
# Todo lo de aquí se alimenta durante la ÚNICA pasada de streaming sobre el archivo:
#  * cabecera Illumina (instrumento, run, flowcell, lane, tile, índice, R1/R2, filtro)
#  * calidad por lane y por tile
#  * errores esperados por lectura (EE = suma de 10^(-Q/10))
#  * duplicación y secuencias sobrerrepresentadas (primeras 100.000 lecturas, 50 pb)
#  * colas poly-G (química de dos colores) y poly-A
#  * composición por base y posición
#  * espectro de k-meros sobre una muestra, con estimación de tamaño de genoma
#
# Nada de esto retiene el archivo: son contadores acotados y muestras de tamaño fijo.

import math, random
from collections import Counter

DUP_READS = 100_000        # lecturas revisadas para duplicación (como FastQC)
DUP_PREFIX = 50            # pb usados como huella de cada lectura
DUP_MAX_KEYS = 400_000     # tope de huellas distintas retenidas
EE_SAMPLE = 20_000         # lecturas muestreadas para los errores esperados (recorrer cada base es caro)
EE_EVERY = 200             # a partir de ahí, 1 de cada N lecturas
COMP_SAMPLE = 5000         # lecturas muestreadas para la composición por base
COMP_MAX_POS = 500
KMER_K = 21
KMER_READS = 12_000        # lecturas muestreadas para el espectro de k-meros
KMER_MAX_KEYS = 1_200_000  # tope de k-meros distintos retenidos
MAX_TILES = 4000
MAX_INDEXES = 5000
POLY_TAIL = 15             # longitud de cola revisada para poly-G / poly-A
RESERVOIR_EVERY = 17       # a partir de 500.000 lecturas, solo 1 de cada N entra en los reservorios

# EE: probabilidad de error de cada carácter de calidad, asumiendo Phred+33.
_EE_P = [0.0] * 256
for _o in range(256):
    _EE_P[_o] = 10 ** (-max(0, _o - 33) / 10.0)

EE_BINS = [0.25, 0.5, 1.0, 2.0, 3.0, 5.0, 10.0]
EE_LABELS = ['≤ 0,25', '0,25–0,5', '0,5–1', '1–2', '2–3', '3–5', '5–10', '> 10']

DUP_LEVELS = [(1, '1'), (2, '2'), (3, '3–4'), (5, '5–9'), (10, '10–49'), (50, '50–99'),
              (100, '100–499'), (500, '500–999'), (1000, '> 1000')]

KNOWN_SOURCES = [
    ('AGATCGGAAGAGC', 'Adaptador Illumina TruSeq'),
    ('CTGTCTCTTATA', 'Adaptador Nextera / transposasa'),
    ('TGGAATTCTCGG', 'Adaptador Small RNA'),
    ('GGGGGGGGGG', 'Cola poly-G (ciclos sin señal)'),
    ('AAAAAAAAAA', 'Cola poly-A'),
    ('TTTTTTTTTT', 'Cola poly-T'),
    ('CGCGCGCGCG', 'Baja complejidad (CG)'),
]

_COMP_TR = str.maketrans('ACGTN', 'TGCAN')


class FastqExtras:
    """Acumula las métricas avanzadas lectura a lectura."""

    def __init__(self):
        self.header_mode = None          # None = aún sin decidir, True/False = es/no es cabecera Illumina
        self.header_checked = 0
        self.instruments, self.runs, self.flowcells = set(), set(), set()
        self.lanes = {}                  # lane -> [lecturas, suma de calidad, bases]
        self.tiles = {}                  # (lane, tile) -> [lecturas, suma de calidad, bases]
        self.indexes = Counter()
        self.reads_r1 = self.reads_r2 = 0
        self.filtered_out = 0

        self.ee_hist = [0] * (len(EE_BINS) + 1)
        self.ee_total = 0.0
        self.ee_le1 = 0
        self.ee_le05 = 0
        self.ee_reads = 0          # lecturas realmente medidas (muestra)
        self.ee_seen = 0           # lecturas candidatas, para muestrear de forma uniforme

        self.dup_counter = Counter()
        self.dup_reads = 0
        self.dup_truncated = False

        self.polyg = 0
        self.polya = 0

        self.comp_sample = []
        self.kmer_sample = []

    # -------------------------------------------------------------- por lectura
    def add(self, desc, seq, qb, count):
        L = len(seq)
        if L:
            # EE: sumar la probabilidad de error base a base es la operación más cara del
            # recorrido, así que se mide sobre una muestra uniforme del archivo.
            # las primeras EE_SAMPLE lecturas, y después 1 de cada EE_EVERY: la muestra
            # cubre todo el archivo sin depender de cuántas lecturas tenga
            self.ee_seen += 1
            if self.ee_reads < EE_SAMPLE or self.ee_seen % EE_EVERY == 0:
                self.ee_reads += 1
                ee = 0.0
                for o in qb:
                    ee += _EE_P[o]
                self.ee_total += ee
                if ee <= 1.0:
                    self.ee_le1 += 1
                    if ee <= 0.5:
                        self.ee_le05 += 1
                i = 0
                while i < len(EE_BINS) and ee > EE_BINS[i]:
                    i += 1
                self.ee_hist[i] += 1

            qsum = sum(qb)
            if self.header_mode is not False:
                self._header(desc, qsum, L)

            tail = seq[-POLY_TAIL:]
            if len(tail) == POLY_TAIL:
                if tail.count('G') == POLY_TAIL or tail.count('g') == POLY_TAIL:
                    self.polyg += 1
                elif tail.count('A') == POLY_TAIL or tail.count('a') == POLY_TAIL:
                    self.polya += 1

        if self.dup_reads < DUP_READS:
            self.dup_reads += 1
            key = seq[:DUP_PREFIX].upper()
            if len(self.dup_counter) < DUP_MAX_KEYS or key in self.dup_counter:
                self.dup_counter[key] += 1
            else:
                self.dup_truncated = True

        # Muestreo por reservorio: la muestra representa TODO el archivo, no solo el principio.
        # Con archivos muy grandes basta con considerar una lectura de cada RESERVOIR_EVERY:
        # ahorra dos llamadas a random por lectura sin sesgar el resultado.
        if count > 500_000 and count % RESERVOIR_EVERY:
            return
        if len(self.comp_sample) < COMP_SAMPLE:
            self.comp_sample.append(seq[:COMP_MAX_POS].upper())
        else:
            j = random.randrange(count)
            if j < COMP_SAMPLE:
                self.comp_sample[j] = seq[:COMP_MAX_POS].upper()
        if len(self.kmer_sample) < KMER_READS:
            self.kmer_sample.append(seq.upper())
        else:
            j = random.randrange(count)
            if j < KMER_READS:
                self.kmer_sample[j] = seq.upper()

    def _header(self, desc, qsum, L):
        """Cabecera Illumina: instrumento:run:flowcell:lane:tile:x:y [read:filtro:control:índice]"""
        space = desc.find(' ')
        left = desc[:space] if space >= 0 else desc
        f = left.split(':')
        if len(f) < 7:
            self.header_checked += 1
            if self.header_checked >= 50 and not self.lanes:
                self.header_mode = False
            return
        self.header_mode = True
        lane, tile = f[3], f[4]
        e = self.lanes.get(lane)
        if e is None:
            if len(self.lanes) > 64:
                return
            e = self.lanes[lane] = [0, 0, 0]
        e[0] += 1; e[1] += qsum; e[2] += L
        key = (lane, tile)
        e = self.tiles.get(key)
        if e is None:
            if len(self.tiles) >= MAX_TILES:
                return
            e = self.tiles[key] = [0, 0, 0]
        e[0] += 1; e[1] += qsum; e[2] += L
        if len(self.instruments) < 8:
            self.instruments.add(f[0])
        if len(self.runs) < 8:
            self.runs.add(f[1])
        if len(self.flowcells) < 8:
            self.flowcells.add(f[2])
        if space >= 0:
            r = desc[space + 1:].split(':')
            if len(r) >= 4:
                if r[0] == '1':
                    self.reads_r1 += 1
                elif r[0] == '2':
                    self.reads_r2 += 1
                if r[1].upper() == 'Y':
                    self.filtered_out += 1
                idx = r[3].strip()
                if idx and (len(self.indexes) < MAX_INDEXES or idx in self.indexes):
                    self.indexes[idx] += 1

    # -------------------------------------------------------------- resultados
    def result(self, count, total_bp, offset):
        out = {
            'ee': None if offset != 33 else self._ee(count),
            'duplication': self._duplication(),
            'polyg_pct': round(self.polyg / count * 100, 3) if count else 0,
            'polya_pct': round(self.polya / count * 100, 3) if count else 0,
            'composition': self._composition(),
            'kmers': self._kmers(count, total_bp),
            'run': self._run(count, offset),
        }
        return out

    def _ee(self, count):
        n = self.ee_reads
        if not n:
            return None
        return {
            'labels': EE_LABELS, 'counts': self.ee_hist, 'sample_size': n, 'sampled': n < count,
            'mean': round(self.ee_total / n, 3),
            'pct_le1': round(self.ee_le1 / n * 100, 2),
            'pct_le05': round(self.ee_le05 / n * 100, 2),
        }

    def _duplication(self):
        if not self.dup_reads:
            return None
        total = sum(self.dup_counter.values())
        distinct = len(self.dup_counter)
        levels = {label: 0 for _, label in DUP_LEVELS}
        for c in self.dup_counter.values():
            label = DUP_LEVELS[0][1]
            for lo, lab in DUP_LEVELS:
                if c >= lo:
                    label = lab
            levels[label] += 1
        top = []
        for seq, c in self.dup_counter.most_common(12):
            pct = c / total * 100
            if pct < 0.1 and len(top) >= 3:
                break
            source = next((name for pat, name in KNOWN_SOURCES if pat in seq), None)
            top.append({'seq': seq, 'count': c, 'pct': round(pct, 3), 'source': source})
        return {
            'reads_checked': self.dup_reads, 'prefix': DUP_PREFIX,
            'distinct': distinct,
            'pct_unique': round(distinct / total * 100, 2) if total else 0,
            'pct_duplicated': round((1 - distinct / total) * 100, 2) if total else 0,
            'levels': {'labels': [lab for _, lab in DUP_LEVELS], 'counts': [levels[lab] for _, lab in DUP_LEVELS]},
            'top': top, 'truncated': self.dup_truncated,
        }

    def _composition(self):
        if not self.comp_sample:
            return None
        max_len = max(len(s) for s in self.comp_sample)
        if not max_len:
            return None
        width = 1 if max_len <= 150 else math.ceil(max_len / 150)
        nbins = math.ceil(max_len / width)
        counts = [[0, 0, 0, 0, 0, 0] for _ in range(nbins)]  # A C G T N total
        idx = {'A': 0, 'C': 1, 'G': 2, 'T': 3, 'U': 3, 'N': 4}
        for s in self.comp_sample:
            for p, ch in enumerate(s):
                row = counts[p // width]
                k = idx.get(ch)
                if k is None:
                    k = 4
                row[k] += 1
                row[5] += 1
        out = {'labels': [], 'A': [], 'C': [], 'G': [], 'T': [], 'N': [],
               'bin_width': width, 'sample_size': len(self.comp_sample)}
        for b, row in enumerate(counts):
            if not row[5]:
                continue
            start = b * width + 1
            out['labels'].append(str(start) if width == 1 else f'{start}–{start + width - 1}')
            for k, key in enumerate(('A', 'C', 'G', 'T', 'N')):
                out[key].append(round(row[k] / row[5] * 100, 2))
        return out

    def _kmers(self, count, total_bp):
        """Espectro de k-meros canónicos sobre la muestra; estima tamaño de genoma y % de error.

        Se recorren k-meros consecutivos (sin saltos) para que el pico de cobertura sea visible.
        El reverso complementario se calcula una sola vez por lectura y los k-meros canónicos
        salen de rebanarlo, que es mucho más rápido que complementar cada k-mero.
        """
        if len(self.kmer_sample) < 200:
            return {'reason': 'few_reads', 'genome_size': None, 'spectrum': None, 'k': KMER_K}
        counter = {}
        truncated = False
        sampled = 0
        for s in self.kmer_sample:
            n = len(s) - KMER_K + 1
            if n <= 0:
                continue
            rc = s.translate(_COMP_TR)[::-1]
            L = len(s)
            for i in range(n):
                km = s[i:i + KMER_K]
                rk = rc[L - KMER_K - i:L - i]
                can = km if km < rk else rk
                v = counter.get(can)
                if v is not None:
                    counter[can] = v + 1
                elif len(counter) < KMER_MAX_KEYS:
                    counter[can] = 1
                else:
                    truncated = True
                    continue
                sampled += 1
        if sampled < 10_000:
            return {'reason': 'few_reads', 'genome_size': None, 'spectrum': None, 'k': KMER_K,
                    'reads_sampled': len(self.kmer_sample), 'distinct': len(counter), 'sampled_kmers': sampled}
        hist = Counter(counter.values())
        max_mult = min(300, max(hist) if hist else 1)
        spectrum = {'labels': list(range(1, max_mult + 1)),
                    'counts': [hist.get(m, 0) for m in range(1, max_mult + 1)]}
        # pico de cobertura: máximo a partir de la multiplicidad 3, para no confundirlo
        # con el pico de errores de secuenciación (k-meros que aparecen una o dos veces)
        peak, best = None, 0
        for m in range(3, max_mult + 1):
            v = hist.get(m, 0)
            if v > best:
                best, peak = v, m
        base = {'k': KMER_K, 'reads_sampled': len(self.kmer_sample), 'distinct': len(counter),
                'sampled_kmers': sampled, 'truncated': truncated, 'spectrum': spectrum, 'peak': peak}
        if not peak or peak < 4 or best < 50:
            base['reason'] = 'truncated' if truncated else 'low_coverage'
            base['genome_size'] = None
            return base
        genome = int(sampled / peak)
        singles = hist.get(1, 0) + hist.get(2, 0)
        base.update({
            'genome_size': genome,
            'error_kmer_pct': round(singles / len(counter) * 100, 1) if counter else None,
            'coverage': round(total_bp / genome, 1) if genome else None,
            'reason': None,
        })
        return base

    def _run(self, count, offset):
        if not self.lanes:
            return None
        lanes = []
        for lane, (reads, qsum, bases) in sorted(self.lanes.items()):
            lanes.append({'lane': lane, 'reads': reads, 'pct': round(reads / count * 100, 2),
                          'quality': round(qsum / bases - offset, 2) if bases else None})
        tiles = []
        for (lane, tile), (reads, qsum, bases) in self.tiles.items():
            if bases:
                tiles.append({'lane': lane, 'tile': tile, 'reads': reads,
                              'quality': round(qsum / bases - offset, 2)})
        tiles.sort(key=lambda x: (x['lane'], x['tile']))
        mean_q = (sum(t['quality'] * t['reads'] for t in tiles) / sum(t['reads'] for t in tiles)) if tiles else None
        worst = sorted(tiles, key=lambda x: x['quality'])[:10] if tiles else []
        idx_total = sum(self.indexes.values())
        indexes = [{'index': k, 'reads': v, 'pct': round(v / idx_total * 100, 2)}
                   for k, v in self.indexes.most_common(12)] if idx_total else []
        return {
            'instruments': sorted(self.instruments), 'runs': sorted(self.runs), 'flowcells': sorted(self.flowcells),
            'lanes': lanes, 'n_tiles': len(tiles), 'tiles': tiles[:1500],
            'tile_mean_quality': round(mean_q, 2) if mean_q is not None else None,
            'worst_tiles': worst, 'indexes': indexes, 'n_indexes': len(self.indexes),
            'reads_r1': self.reads_r1, 'reads_r2': self.reads_r2,
            'filtered_out': self.filtered_out,
            'pct_filtered_out': round(self.filtered_out / count * 100, 2) if count else 0,
        }


def expected_errors(qb, offset=33):
    """EE de una lectura a partir de sus calidades en bytes."""
    if offset == 33:
        return sum(_EE_P[o] for o in qb)
    return sum(10 ** (-max(0, o - offset) / 10.0) for o in qb)
