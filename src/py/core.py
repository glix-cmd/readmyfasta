# READMYFASTA — motor de análisis (Python estándar, se ejecuta con Pyodide dentro de un Web Worker).
#
# Principios:
#  * Streaming: el archivo se monta con WORKERFS y se lee línea a línea; nunca se carga entero en memoria.
#  * Las estadísticas se calculan sobre el archivo COMPLETO.
#  * Para el listado, la búsqueda, los motivos y el detalle se retienen en memoria los registros hasta un
#    presupuesto fijo; si el archivo lo supera, se avisa al usuario (la exportación sí recorre todo el archivo).
#  * Los errores de usuario se lanzan como UserError(código) y la interfaz los traduce a mensajes claros.

import gzip, io, csv, json, random, re, math, zlib, itertools
from array import array
from collections import Counter

from fastq_extras import FastqExtras, expected_errors

STORE_BUDGET_CHARS = 400_000_000   # caracteres de secuencia+calidad retenidos para listado/motivos/detalle
MAX_LITE = 2_000_000               # registros con fila en el listado
MAX_STRUCTURE_MB = 120
QUAL_SAMPLE = 5000                 # lecturas muestreadas (reservorio) para la calidad por posición
PROGRESS_EVERY = 40_000            # líneas entre avisos de progreso

ADAPTERS = {'Illumina TruSeq': 'AGATCGGAAGAGC', 'Nextera': 'CTGTCTCTTATA', 'Small RNA': 'TGGAATTCTCGG'}


class UserError(Exception):
    def __init__(self, code, **info):
        super().__init__(code)
        self.code = code
        self.info = info


def _err_json(e):
    return json.dumps({'error': e.code, 'info': e.info})


# ------------------------------------------------------------------ apertura y detección
class _Source:
    """Envuelve el archivo crudo, la capa gzip opcional y el texto decodificado."""

    def __init__(self, path, report=None):
        self.raw = open(path, 'rb', buffering=1 << 20)
        self.raw.seek(0, 2)
        self.size = self.raw.tell() or 1
        self.raw.seek(0)
        self.report = report
        head = self.raw.peek(16)[:16]
        self.compressed = head[:2] == b'\x1f\x8b'
        _check_magic(head, compressed=False)
        stream = self.raw
        if self.compressed:
            stream = gzip.GzipFile(fileobj=self.raw)      # gzip de Python: admite gzip multi-miembro y BGZF
            try:
                inner = stream.peek(16)[:16]
            except (OSError, EOFError, zlib.error):
                raise UserError('gz_invalid')
            _check_magic(inner, compressed=True)
        self.text = io.TextIOWrapper(stream, encoding='utf-8-sig', errors='replace', newline=None)
        self._n = 0

    def lines(self):
        """Itera líneas sin salto final; traduce errores de descompresión a mensajes claros."""
        rep = self.report
        try:
            for line in self.text:
                self._n += 1
                if rep is not None and self._n % PROGRESS_EVERY == 0:
                    rep(self.raw.tell() / self.size)
                yield line.rstrip('\n')
        except EOFError:
            raise UserError('gz_truncated')
        except (gzip.BadGzipFile, zlib.error):
            raise UserError('gz_corrupt')

    def close(self):
        try:
            self.text.close()
        except Exception:
            pass
        try:
            self.raw.close()
        except Exception:
            pass


def _check_magic(head, compressed):
    if head[:4] == b'BAM\x01':
        raise UserError('is_bam')
    if head[:4] == b'BAI\x01':
        raise UserError('is_bai')
    if head[:4] == b'PK\x03\x04':
        raise UserError('zip')
    if head[:4] == b'%PDF':
        raise UserError('pdf')
    if head[:4] == b'ABIF':
        raise UserError('ab1')
    if head[:4] == b'CRAM':
        raise UserError('cram')
    if head[:3] == b'BZh':
        raise UserError('bz2')
    if head[:6] == b'\xfd7zXZ\x00' or head[:4] == b'\x28\xb5\x2f\xfd':
        raise UserError('other_compression')
    if head[:4] == b'\xd0\xcf\x11\xe0':
        raise UserError('office_old')
    if not compressed and head[:2] == b'\x1f\x8b':
        return
    if b'\x00' in head[:16] and head[:2] != b'\x1f\x8b':
        raise UserError('binary')


NUC_CHARS = set('ACGTUNacgtun')
SEQ_LINE_RE = re.compile(r'^[ACGTUNRYSWKMBDHVacgtunryswkmbdhv\-\.\*\s]+$')
PDB_TAGS = ('HEADER', 'ATOM  ', 'HETATM', 'CRYST1', 'MODEL ', 'REMARK', 'TITLE ', 'COMPND', 'EXPDTA', 'SEQRES', 'SOURCE', 'KEYWDS')


def _ext(filename):
    parts = filename.lower().split('.')
    if len(parts) > 1 and parts[-1] in ('gz', 'bgz'):
        parts = parts[:-1]
    return parts[-1] if len(parts) > 1 else ''


def _detect_kind(first, ext):
    if first.startswith('##fileformat=VCF'):
        return 'vcf'
    if first.startswith(('@HD\t', '@SQ\t', '@RG\t', '@PG\t', '@CO\t')):
        return 'sam'
    if first.startswith('>'):
        return 'fasta'
    if first.startswith('@'):
        return 'fastq'
    if first.startswith('data_') or ext in ('cif', 'mmcif'):
        return 'cif'
    if first.startswith(PDB_TAGS) or ext in ('pdb', 'ent'):
        return 'pdb'
    if ext in ('csv', 'tsv', 'tab'):
        return 'tabular'
    stripped = first.strip()
    if stripped and SEQ_LINE_RE.match(stripped) and len(stripped) >= 10:
        return 'rawseq'
    if ext in ('fasta', 'fa', 'fna', 'fas', 'fsa', 'faa', 'ffn', 'frn', 'seq'):
        return 'rawseq'
    return 'tabular'


# ------------------------------------------------------------------ estado global
STATE = {}


def _reset():
    STATE.clear()
    STATE.update(kind=None, filename='', path='', descs=[], seqs=[], quals=[],
                 lens=array('I'), gcs=array('f'), qms=array('f'),
                 alphabet='dna', phred_offset=33, stored=0, lite=0)


# ------------------------------------------------------------------ utilidades de secuencia
_COMP = str.maketrans('ACGTUNRYSWKMBDHVacgtunryswkmbdhv', 'TGCAANYRSWMKVHDBtgcaanyrswmkvhdb')


def revcomp(s):
    return s.translate(_COMP)[::-1]


IUPAC = {'A': 'A', 'C': 'C', 'G': 'G', 'T': '[TU]', 'U': '[TU]', 'R': '[AG]', 'Y': '[CTU]', 'S': '[CG]',
         'W': '[ATU]', 'K': '[GTU]', 'M': '[AC]', 'B': '[CGTU]', 'D': '[AGTU]', 'H': '[ACTU]', 'V': '[ACG]',
         'N': '[ACGTUN]'}

_CODON = {}
_bases = 'TCAG'
_aas = 'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG'
for _i, _c in enumerate(itertools.product(_bases, repeat=3)):
    _CODON[''.join(_c)] = _aas[_i]


def translate(s):
    s = s.upper().replace('U', 'T')
    return ''.join(_CODON.get(s[i:i + 3], 'X') for i in range(0, len(s) - 2, 3))


def _gc(seq):
    g = seq.count('G') + seq.count('g')
    c = seq.count('C') + seq.count('c')
    a = seq.count('A') + seq.count('a')
    t = seq.count('T') + seq.count('t') + seq.count('U') + seq.count('u')
    n = seq.count('N') + seq.count('n')
    acgt = a + c + g + t
    return (round((g + c) / acgt * 100, 2) if acgt else 0.0), n, acgt


def _store_record(desc, seq, qual, gc, qm):
    st = STATE
    if st['lite'] < MAX_LITE:
        st['descs'].append(desc)
        st['lens'].append(len(seq))
        st['gcs'].append(gc)
        st['qms'].append(qm)
        st['lite'] += 1
        cost = len(seq) + (len(qual) if qual else 0)
        if st['stored'] == len(st['seqs']) and st['stored_chars'] + cost <= STORE_BUDGET_CHARS:
            st['seqs'].append(seq)
            if qual is not None:
                st['quals'].append(qual)
            st['stored'] += 1
            st['stored_chars'] += cost


# ------------------------------------------------------------------ iteradores de registros
def _iter_fasta(lines, first, raw_mode=False):
    header = 'secuencia_1' if raw_mode else None
    chunks = []
    pending = [first] if first is not None else []
    for line in itertools.chain(pending, lines):
        if line.startswith('>'):
            if header is not None:
                yield header, ''.join(chunks)
            header = line[1:].strip()
            chunks = []
        else:
            s = line.strip()
            if s:
                if header is None:
                    header = 'secuencia_1'
                chunks.append(s.replace(' ', ''))
    if header is not None:
        yield header, ''.join(chunks)


def _iter_fastq(lines, first):
    it = itertools.chain([first], lines)
    n = 0
    for h in it:
        if not h.strip():
            continue
        n += 1
        if not h.startswith('@'):
            raise UserError('fastq_bad_header', record=n)
        s = next(it, None)
        plus = next(it, None)
        q = next(it, None)
        if q is None:
            STATE.setdefault('warnings', []).append({'code': 'fastq_truncated_tail', 'record': n})
            return
        if not plus.startswith('+'):
            raise UserError('fastq_bad_plus', record=n)
        s = s.strip()
        q = q.strip()
        if len(s) != len(q):
            raise UserError('fastq_len_mismatch', record=n)
        yield h[1:].strip(), s, q


def _open_records(path, filename, report=None):
    """Abre el archivo y devuelve (source, kind, iterador de registros)."""
    src = _Source(path, report)
    lines = src.lines()
    first = None
    for line in lines:
        if line.strip():
            first = line
            break
    if first is None:
        src.close()
        raise UserError('empty')
    kind = _detect_kind(first, _ext(filename))
    return src, kind, lines, first


# ------------------------------------------------------------------ procesado principal
def process_upload(path, filename, report=None):
    try:
        return _process(path, filename, report)
    except UserError as e:
        return _err_json(e)
    except MemoryError:
        return json.dumps({'error': 'memory', 'info': {}})


def _process(path, filename, report):
    _reset()
    STATE.update(filename=filename, path=path, stored_chars=0, warnings=[])
    src, kind, lines, first = _open_records(path, filename, report)
    STATE['compressed'] = src.compressed
    try:
        if kind in ('vcf', 'sam'):
            raise UserError('is_' + kind)
        if kind in ('pdb', 'cif'):
            return _process_structure(src, lines, first, kind)
        if kind == 'tabular':
            return _process_tabular(src, lines, first, _ext(filename))
        if kind == 'fastq':
            return _process_fastq(src, lines, first)
        return _process_fasta(src, lines, first, raw_mode=(kind == 'rawseq'))
    finally:
        src.close()


def _length_counter_add(counter, L):
    counter[L if L < 10000 else (L // 100) * 100] += 1


def _length_stats(counter, total_bp, count):
    if not count:
        return {'n50': 0, 'l50': 0, 'n90': 0, 'median': 0}
    keys = sorted(counter, reverse=True)
    acc = 0
    cnt = 0
    n50 = l50 = n90 = None
    for k in keys:
        acc += k * counter[k]
        cnt += counter[k]
        if n50 is None and acc >= total_bp / 2:
            n50, l50 = k, cnt
        if n90 is None and acc >= total_bp * 0.9:
            n90 = k
            break
    half = (count + 1) // 2
    run = 0
    median = 0
    for k in sorted(counter):
        run += counter[k]
        if run >= half:
            median = k
            break
    return {'n50': n50 or 0, 'l50': l50 or 0, 'n90': n90 or 0, 'median': median}


def _length_hist(counter, nbins=30):
    if not counter:
        return {'labels': [], 'counts': []}
    lo, hi = min(counter), max(counter)
    if lo == hi:
        return {'labels': [str(lo)], 'counts': [sum(counter.values())]}
    width = max(1, math.ceil((hi - lo + 1) / nbins))
    counts = [0] * nbins
    for k, v in counter.items():
        counts[min(nbins - 1, (k - lo) // width)] += v
    labels = [f'{lo + i * width}–{lo + (i + 1) * width - 1}' for i in range(nbins)]
    while counts and counts[-1] == 0:
        counts.pop()
        labels.pop()
    return {'labels': labels, 'counts': counts}


def _alphabet(nuc, total, u, t):
    if total == 0:
        return 'dna'
    if nuc / total >= 0.9:
        return 'rna' if u > t else 'dna'
    return 'protein'


def _process_fasta(src, lines, first, raw_mode):
    count = total_bp = total_n = total_acgt = total_lower = 0
    gc_hist = [0] * 101
    lc = Counter()
    nuc = tot = u_cnt = t_cnt = 0
    ids = Counter()          # IDs repetidos: rompen muchos pipelines aguas abajo
    seq_hashes = {}          # secuencias idénticas (por hash, con verificación de longitud)
    id_capped = seq_capped = False
    for desc, seq in _iter_fasta(lines, first, raw_mode):
        L = len(seq)
        gc, n, acgt = _gc(seq)
        total_lower += sum(seq.count(c) for c in 'acgtnu')
        rid = desc.split()[0] if desc.split() else ''
        if rid:
            if len(ids) < 2_000_000 or rid in ids:
                ids[rid] += 1
            else:
                id_capped = True
        h = (hash(seq.upper() if L < 1_000_000 else seq), L)
        if h in seq_hashes:
            seq_hashes[h] += 1
        elif len(seq_hashes) < 2_000_000:
            seq_hashes[h] = 1
        else:
            seq_capped = True
        if tot < 1_000_000:
            chunk = seq[:200_000]
            letters = sum(1 for ch in chunk if ch.isalpha())
            tot += letters
            nuc += sum(chunk.count(ch) for ch in NUC_CHARS)
            u_cnt += chunk.count('U') + chunk.count('u')
            t_cnt += chunk.count('T') + chunk.count('t')
        count += 1
        total_bp += L
        total_n += n
        total_acgt += acgt
        if acgt:
            gc_hist[int(round(gc))] += 1
        _length_counter_add(lc, L)
        _store_record(desc, seq, None, gc, -1.0)
    if count == 0:
        raise UserError('no_records')
    alphabet = _alphabet(nuc, tot, u_cnt, t_cnt)
    STATE.update(kind='fasta', alphabet=alphabet)
    dup_ids = [{'id': k, 'count': v} for k, v in ids.most_common(20) if v > 1]
    n_dup_ids = sum(1 for v in ids.values() if v > 1)
    dup_seq_groups = sum(1 for v in seq_hashes.values() if v > 1)
    dup_seq_extra = sum(v - 1 for v in seq_hashes.values() if v > 1)
    if n_dup_ids:
        STATE['warnings'].append({'code': 'dup_ids', 'n': n_dup_ids, 'capped': id_capped})
    if dup_seq_extra:
        STATE['warnings'].append({'code': 'dup_seqs', 'n': dup_seq_extra, 'groups': dup_seq_groups,
                                  'capped': seq_capped})
    gcs_all = STATE['gcs']
    summary = {
        'kind_label': 'FASTA', 'is_fastq': False, 'alphabet': alphabet, 'compressed': src.compressed,
        'count': count, 'total_bp': total_bp,
        'avg_len': round(total_bp / count, 1), 'min_len': min(lc), 'max_len': max(lc),
        'avg_gc': round(sum(gcs_all) / len(gcs_all), 2) if (gcs_all and alphabet != 'protein') else None,
        'pct_n': round(total_n / total_bp * 100, 3) if (total_bp and alphabet != 'protein') else None,
        'pct_softmasked': round(total_lower / total_bp * 100, 2) if (total_bp and alphabet != 'protein') else None,
        'n_dup_ids': n_dup_ids, 'dup_ids': dup_ids,
        'dup_seq_groups': dup_seq_groups, 'dup_seq_extra': dup_seq_extra,
        **_length_stats(lc, total_bp, count),
    }
    return _finish_sequence(summary, lc, gc_hist, None)


def _process_fastq(src, lines, first):
    count = total_bp = total_n = 0
    q20 = q30 = q30_64 = 0
    qmin, qmax = 255, 0
    gc_hist = [0] * 101
    qmean_hist = [0] * 128
    lc = Counter()
    adapters = {k: 0 for k in ADAPTERS}
    adapter_checked = 0
    sample = []
    extras = FastqExtras()
    del20 = bytes(range(0, 33 + 20))
    del30 = bytes(range(0, 33 + 30))
    del30_64 = bytes(range(0, 64 + 30))
    for desc, seq, qual in _iter_fastq(lines, first):
        L = len(seq)
        qb = qual.encode('ascii', 'replace')
        count += 1
        total_bp += L
        gc, n, acgt = _gc(seq)
        total_n += n
        if acgt:
            gc_hist[int(round(gc))] += 1
        _length_counter_add(lc, L)
        if L:
            mn, mx = min(qb), max(qb)
            if mn < qmin:
                qmin = mn
            if mx > qmax:
                qmax = mx
            s = sum(qb)
            raw_mean = s / L
            qmean_hist[min(127, int(raw_mean))] += 1
            q20 += len(qb.translate(None, del20))
            q30 += len(qb.translate(None, del30))
            q30_64 += len(qb.translate(None, del30_64))
        else:
            raw_mean = 33.0
        extras.add(desc, seq, qb, count)
        if adapter_checked < 200_000:
            adapter_checked += 1
            for name, a in ADAPTERS.items():
                if a in seq:
                    adapters[name] += 1
        if len(sample) < QUAL_SAMPLE:
            sample.append(qb)
        else:
            j = random.randrange(count)
            if j < QUAL_SAMPLE:
                sample[j] = qb
        _store_record(desc, seq, qual, gc, raw_mean)
    if count == 0:
        raise UserError('no_records')
    offset = 64 if (qmin >= 64 and qmax > 74) else 33
    if offset == 64:
        STATE['warnings'].append({'code': 'phred64'})
        q30 = q30_64
    STATE.update(kind='fastq', alphabet='dna', phred_offset=offset)
    qms = STATE['qms']
    mean_q = sum(k * v for k, v in enumerate(qmean_hist)) / count - offset
    summary = {
        'kind_label': 'FASTQ', 'is_fastq': True, 'alphabet': 'dna', 'compressed': src.compressed,
        'count': count, 'total_bp': total_bp,
        'avg_len': round(total_bp / count, 1), 'min_len': min(lc), 'max_len': max(lc),
        'avg_gc': round(sum(STATE['gcs']) / len(STATE['gcs']), 2) if STATE['gcs'] else 0,
        'pct_n': round(total_n / total_bp * 100, 3) if total_bp else 0,
        'avg_quality': round(mean_q, 2),
        'pct_q30': round(q30 / total_bp * 100, 2) if total_bp else 0,
        'pct_q20': round(q20 / total_bp * 100, 2) if (total_bp and offset == 33) else None,
        'phred_offset': offset,
        'adapters': {k: round(v / adapter_checked * 100, 2) for k, v in adapters.items()} if adapter_checked else {},
        'adapter_reads_checked': adapter_checked,
        **_length_stats(lc, total_bp, count),
    }
    ex = extras.result(count, total_bp, offset)
    if ex['ee']:
        summary['ee_mean'] = ex['ee']['mean']
        summary['ee_pct_le1'] = ex['ee']['pct_le1']
    if ex['duplication']:
        summary['pct_duplicated'] = ex['duplication']['pct_duplicated']
    summary['polyg_pct'] = ex['polyg_pct']
    summary['polya_pct'] = ex['polya_pct']
    if ex['kmers'] and ex['kmers'].get('genome_size'):
        summary['genome_size'] = ex['kmers']['genome_size']
        summary['kmer_coverage'] = ex['kmers'].get('coverage')
    if ex['run']:
        summary['n_lanes'] = len(ex['run']['lanes'])
        summary['n_tiles'] = ex['run']['n_tiles']
    if ex['polyg_pct'] >= 1:
        STATE['warnings'].append({'code': 'polyg', 'pct': ex['polyg_pct']})
    if ex['duplication'] and ex['duplication']['pct_duplicated'] >= 40:
        STATE['warnings'].append({'code': 'duplication', 'pct': ex['duplication']['pct_duplicated']})
    if ex['run'] and len(ex['run']['runs']) > 1:
        STATE['warnings'].append({'code': 'multi_run', 'n': len(ex['run']['runs'])})
    if offset != 33:
        STATE['warnings'].append({'code': 'ee_unavailable'})
    nz = [k for k, v in enumerate(qmean_hist) if v]
    lo, hi = (nz[0], nz[-1]) if nz else (offset, offset)
    qhist = {'labels': [k - offset for k in range(lo, hi + 1)], 'counts': qmean_hist[lo:hi + 1]}
    return _finish_sequence(summary, lc, gc_hist, _quality_profile(sample, offset), qhist, ex)


def _quality_profile(sample, offset):
    if not sample:
        return None
    max_len = max(len(q) for q in sample)
    if max_len == 0:
        return None
    width = 1 if max_len <= 150 else math.ceil(max_len / 150)
    nbins = math.ceil(max_len / width)
    hists = [[0] * 128 for _ in range(nbins)]
    for qb in sample:
        L = len(qb)
        step = max(1, L // 400)
        for p in range(0, L, step):
            hists[p // width][min(127, qb[p])] += 1
    out = {'labels': [], 'p10': [], 'p25': [], 'p50': [], 'p75': [], 'p90': [], 'mean': [],
           'bin_width': width, 'sample_size': len(sample)}
    for b, h in enumerate(hists):
        tot = sum(h)
        if tot == 0:
            continue
        cuts = {}
        acc = 0
        targets = [(0.10, 'p10'), (0.25, 'p25'), (0.50, 'p50'), (0.75, 'p75'), (0.90, 'p90')]
        ti = 0
        for v, c in enumerate(h):
            acc += c
            while ti < len(targets) and acc >= targets[ti][0] * tot:
                cuts[targets[ti][1]] = v - offset
                ti += 1
        start = b * width + 1
        out['labels'].append(str(start) if width == 1 else f'{start}–{start + width - 1}')
        for key in ('p10', 'p25', 'p50', 'p75', 'p90'):
            out[key].append(cuts.get(key, 0))
        out['mean'].append(round(sum(v * c for v, c in enumerate(h)) / tot - offset, 2))
    return out


def _finish_sequence(summary, lc, gc_hist, qprofile, qhist=None, extras=None):
    st = STATE
    summary['stored'] = st['stored']
    summary['listed'] = st['lite']
    if st['lite'] < summary['count']:
        st['warnings'].append({'code': 'lite_capped', 'listed': st['lite'], 'total': summary['count']})
    if st['stored'] < summary['count']:
        st['warnings'].append({'code': 'store_capped', 'stored': st['stored'], 'total': summary['count']})
    if summary['alphabet'] == 'protein':
        st['warnings'].append({'code': 'protein'})
    gcs = [v for v in gc_hist]
    nz = [i for i, v in enumerate(gcs) if v]
    gc_mean = gc_sd = None
    if nz:
        tot = sum(gcs)
        gc_mean = sum(i * v for i, v in enumerate(gcs)) / tot
        gc_sd = math.sqrt(max(0.0, sum(((i - gc_mean) ** 2) * v for i, v in enumerate(gcs)) / tot))
    charts = {
        'length': _length_hist(lc),
        'gc': {'counts': gcs, 'mean': gc_mean, 'sd': gc_sd} if summary['alphabet'] != 'protein' else None,
        'quality_profile': qprofile,
        'quality_hist': qhist,
    }
    out = {'kind': 'sequence', 'summary': summary, 'warnings': st['warnings'], 'charts': charts}
    if extras:
        charts['composition'] = extras['composition']
        charts['ee'] = extras['ee']
        charts['kmers'] = extras['kmers']
        charts['duplication'] = extras['duplication']['levels'] if extras['duplication'] else None
        out['run'] = extras['run']
        out['duplication'] = extras['duplication']
        out['kmers'] = extras['kmers']
    return json.dumps(out)


# ------------------------------------------------------------------ tablas
DECIMAL_COMMA_RE = re.compile(r'^[-+]?\d{1,3}(\.\d{3})*,\d+$|^[-+]?\d+,\d+$')


def _to_float(v):
    v = v.strip()
    if not v:
        return None, False
    try:
        return float(v), False
    except ValueError:
        pass
    if DECIMAL_COMMA_RE.match(v):
        try:
            return float(v.replace('.', '').replace(',', '.')), True
        except ValueError:
            return None, False
    return None, False


DE_PATTERNS = [
    ('DESeq2', 'log2foldchange', 'padj'),
    ('edgeR', 'logfc', 'fdr'),
    ('limma', 'logfc', 'adj.p.val'),
]


def _process_tabular(src, lines, first, ext):
    head = [first]
    for line in lines:
        head.append(line)
        if len(head) >= 50:
            break
    sample = '\n'.join(head)
    if ext == 'tsv' or ext == 'tab':
        delimiter = '\t'
    else:
        cands = ',;\t|' if ext != 'csv' else ',;'
        try:
            delimiter = csv.Sniffer().sniff(sample, delimiters=cands).delimiter
        except csv.Error:
            delimiter = max(cands, key=lambda d: first.count(d))
            if first.count(delimiter) == 0:
                raise UserError('unknown_text')
    reader = csv.reader(itertools.chain(head, lines), delimiter=delimiter)
    header = None
    preview = []
    n_rows = 0
    ncols = 0
    numeric = []
    non_empty = []
    comma_dec = 0
    de = None
    points = []
    for row in reader:
        if not row or all(not c.strip() for c in row):
            continue
        if header is None:
            header = [h.strip() for h in row]
            ncols = len(header)
            numeric = [0] * ncols
            non_empty = [0] * ncols
            low = [h.lower() for h in header]
            for tool, fc, p in DE_PATTERNS:
                if fc in low and p in low:
                    de = {'tool': tool, 'fc': low.index(fc), 'p': low.index(p), 'fc_name': header[low.index(fc)],
                          'p_name': header[low.index(p)], 'label': 0}
                    break
            continue
        n_rows += 1
        if len(preview) < 200:
            preview.append(row)
        if n_rows <= 100_000:
            for c in range(min(ncols, len(row))):
                v = row[c]
                if v.strip():
                    non_empty[c] += 1
                    val, used_comma = _to_float(v)
                    if val is not None:
                        numeric[c] += 1
                        comma_dec += used_comma
        if de is not None and len(points) < 60_000 and len(row) > max(de['fc'], de['p']):
            fc_v, _ = _to_float(row[de['fc']])
            p_v, _ = _to_float(row[de['p']])
            if fc_v is not None and p_v is not None and p_v > 0 and math.isfinite(fc_v):
                points.append([round(fc_v, 4), round(-math.log10(p_v), 4), row[0][:40]])
    if header is None:
        raise UserError('no_records')
    if ncols < 2:
        raise UserError('unknown_text')
    if comma_dec:
        STATE['warnings'].append({'code': 'decimal_comma'})
    cols = [{'name': header[c] or f'col{c + 1}', 'non_empty': non_empty[c],
             'numeric_pct': round(numeric[c] / non_empty[c] * 100, 1) if non_empty[c] else 0} for c in range(ncols)]
    STATE['kind'] = 'tabular'
    label = {',': 'CSV', ';': 'CSV (;)', '\t': 'TSV', '|': 'Tabla (|)'}.get(delimiter, 'Tabla')
    result = {'kind': 'tabular', 'warnings': STATE['warnings'],
              'summary': {'kind_label': label, 'n_rows': n_rows, 'n_cols': ncols, 'columns': cols,
                          'delimiter': delimiter, 'compressed': src.compressed},
              'records': [header] + preview}
    if de and points:
        result['de'] = {'tool': de['tool'], 'fc_name': de['fc_name'], 'p_name': de['p_name'], 'points': points,
                        'truncated': len(points) >= 60_000}
    return json.dumps(result)



# ------------------------------------------------------------------ cadenas de una estructura
AA3TO1 = {
    'ALA': 'A', 'ARG': 'R', 'ASN': 'N', 'ASP': 'D', 'CYS': 'C', 'GLN': 'Q', 'GLU': 'E', 'GLY': 'G',
    'HIS': 'H', 'ILE': 'I', 'LEU': 'L', 'LYS': 'K', 'MET': 'M', 'PHE': 'F', 'PRO': 'P', 'SER': 'S',
    'THR': 'T', 'TRP': 'W', 'TYR': 'Y', 'VAL': 'V', 'SEC': 'U', 'PYL': 'O', 'MSE': 'M', 'HSD': 'H',
    'HSE': 'H', 'HSP': 'H', 'CSO': 'C', 'PTR': 'Y', 'SEP': 'S', 'TPO': 'T', 'MLY': 'K', 'HYP': 'P',
}
NUC3TO1 = {'DA': 'A', 'DC': 'C', 'DG': 'G', 'DT': 'T', 'DU': 'U', 'DI': 'I',
           'A': 'A', 'C': 'C', 'G': 'G', 'U': 'U', 'T': 'T', 'I': 'I', 'N': 'N'}
MAX_CHAIN_POINTS = 600


def _residue_letter(resname):
    """Devuelve (letra, tipo) para un residuo; tipo: protein | nucleic | other."""
    rn = resname.strip().upper()
    if rn in AA3TO1:
        return AA3TO1[rn], 'protein'
    if rn in NUC3TO1:
        return NUC3TO1[rn], 'nucleic'
    return 'X', 'other'


def _chain_report(chain_data, alphafold):
    """chain_data: {cadena: [(num, icode, resname, bfactor|None), ...]} en orden de aparición."""
    out = []
    for chain, residues in chain_data.items():
        if not residues:
            continue
        letters = []
        kinds = Counter()
        bvals = []
        gaps = []
        prev_num = None
        for num, icode, resname, b in residues:
            letter, kind = _residue_letter(resname)
            kinds[kind] += 1
            letters.append(letter)
            if b is not None:
                bvals.append(b)
            if prev_num is not None and num is not None and not icode:
                missing = num - prev_num - 1
                if missing > 0:
                    gaps.append({'after': prev_num, 'before': num, 'missing': missing})
                elif missing < 0:
                    gaps.append({'after': prev_num, 'before': num, 'missing': None})  # numeración no monótona
            if num is not None:
                prev_num = num
        kind = kinds.most_common(1)[0][0] if kinds else 'other'
        nums = [r[0] for r in residues if r[0] is not None]
        step = max(1, math.ceil(len(bvals) / MAX_CHAIN_POINTS))
        entry = {
            'chain': chain, 'type': kind, 'n_residues': len(residues),
            'first': min(nums) if nums else None, 'last': max(nums) if nums else None,
            'seq': ''.join(letters), 'gaps': gaps[:200], 'n_gaps': len(gaps),
            'missing_residues': sum(g['missing'] or 0 for g in gaps),
            'bfactor': {
                'labels': [str(residues[i][0]) for i in range(0, len(bvals), step)],
                'values': [round(bvals[i], 2) for i in range(0, len(bvals), step)],
                'mean': round(sum(bvals) / len(bvals), 2), 'step': step,
                'min': round(min(bvals), 2), 'max': round(max(bvals), 2),
            } if bvals else None,
        }
        if alphafold and entry['bfactor']:
            vals = [b for b in bvals]
            entry['plddt_bands'] = {
                'very_high': round(sum(1 for b in vals if b > 90) / len(vals) * 100, 1),
                'high': round(sum(1 for b in vals if 70 < b <= 90) / len(vals) * 100, 1),
                'low': round(sum(1 for b in vals if 50 < b <= 70) / len(vals) * 100, 1),
                'very_low': round(sum(1 for b in vals if b <= 50) / len(vals) * 100, 1),
            }
        out.append(entry)
    return out


# ------------------------------------------------------------------ estructuras (PDB / mmCIF)
def _process_structure(src, lines, first, kind):
    parts = [first]
    size = len(first)
    limit = MAX_STRUCTURE_MB * 1_000_000
    for line in lines:
        parts.append(line)
        size += len(line) + 1
        if size > limit:
            raise UserError('structure_too_big', mb=MAX_STRUCTURE_MB)
    text = '\n'.join(parts) + '\n'
    summary = _parse_pdb(parts) if kind == 'pdb' else _parse_cif(parts)
    summary['kind_label'] = 'PDB' if kind == 'pdb' else 'mmCIF'
    summary['compressed'] = src.compressed
    STATE['kind'] = 'structure'
    if summary['atoms'] + summary['hetatms'] == 0:
        raise UserError('no_atoms')
    missing = sum(c['missing_residues'] for c in summary.get('chain_detail', []))
    if missing:
        STATE['warnings'].append({'code': 'chain_gaps', 'n': missing,
                                  'chains': sum(1 for c in summary['chain_detail'] if c['n_gaps'])})
    return json.dumps({'kind': 'structure', 'summary': summary, 'warnings': STATE['warnings'],
                       'records': [], 'structure_text': text, 'structure_format': kind})


def _plddt_like(bvals, text_head):
    if not bvals:
        return False
    if 'ALPHAFOLD' in text_head.upper():
        return True
    return False


def _parse_pdb(lines):
    atoms = hetatms = models = 0
    chains, residues, het_names = set(), set(), set()
    bvals = []
    chain_data = {}
    seen_res = set()
    model_no = 0
    resolution = method = None
    head = '\n'.join(lines[:60])
    for line in lines:
        rt = line[0:6]
        if rt in ('ATOM  ', 'HETATM'):
            chain = line[21] if len(line) > 21 else ''
            chains.add(chain)
            residues.add((chain, line[22:27].strip()))
            if rt == 'ATOM  ':
                atoms += 1
                if len(bvals) < 200_000:
                    try:
                        bvals.append(float(line[60:66]))
                    except ValueError:
                        pass
                # un residuo por cadena, solo del primer modelo, en orden de aparición
                if model_no <= 1 and chain.strip():
                    icode = line[26:27].strip()
                    key = (chain, line[22:26].strip(), icode)
                    if key not in seen_res and len(seen_res) < 200_000:
                        seen_res.add(key)
                        try:
                            num = int(line[22:26])
                        except ValueError:
                            num = None
                        try:
                            b = float(line[60:66])
                        except ValueError:
                            b = None
                        chain_data.setdefault(chain, []).append((num, icode, line[17:20], b))
            else:
                hetatms += 1
                rn = line[17:20].strip()
                if rn:
                    het_names.add(rn)
        elif rt == 'MODEL ':
            models += 1
            model_no += 1
        elif rt == 'EXPDTA':
            method = line[10:].strip()
        elif line.startswith('REMARK   2 RESOLUTION.'):
            m = re.search(r'([\d.]+)\s*ANGSTROM', line)
            if m:
                resolution = float(m.group(1))
    return {'atoms': atoms, 'hetatms': hetatms, 'n_chains': len([c for c in chains if c.strip()]),
            'chains': sorted(c for c in chains if c.strip()), 'n_residues': len(residues),
            'n_models': max(models, 1), 'het_groups': sorted(het_names)[:30],
            'method': method, 'resolution': resolution, 'alphafold': _plddt_like(bvals, head),
            'chain_detail': _chain_report(chain_data, _plddt_like(bvals, head))}


def _parse_cif(lines):
    atoms = hetatms = 0
    chains, residues, het_names, models = set(), set(), set(), set()
    chain_data = {}
    seen_res = set()
    cols = []
    in_loop = in_atoms = False
    method = resolution = None
    alphafold = False
    for line in lines:
        s = line.strip()
        if s.startswith('_exptl.method'):
            method = s.split(None, 1)[1].strip("'\"") if len(s.split(None, 1)) > 1 else None
        elif s.startswith('_refine.ls_d_res_high'):
            try:
                resolution = float(s.split()[1])
            except (IndexError, ValueError):
                pass
        if not alphafold and ('alphafold' in s.lower() or s.startswith('_ma_qa_metric')):
            alphafold = True
        if s == 'loop_':
            in_loop, in_atoms, cols = True, False, []
            continue
        if in_loop and s.startswith('_atom_site.'):
            cols.append(s.split('.', 1)[1].split()[0])
            in_atoms = True
            continue
        if in_atoms and cols:
            if not s or s.startswith(('_', 'loop_', '#', 'data_')):
                in_atoms = False
                in_loop = False
                continue
            f = s.split()
            if len(f) < len(cols):
                continue
            get = lambda name: f[cols.index(name)] if name in cols else ''
            group = get('group_PDB')
            if group != 'HETATM' and (get('pdbx_PDB_model_num') or '1') in ('1', '.', ''):
                ch = get('auth_asym_id') or get('label_asym_id')
                rnum = get('auth_seq_id') or get('label_seq_id')
                icode = get('pdbx_PDB_ins_code')
                icode = '' if icode in ('.', '?') else icode
                key = (ch, rnum, icode)
                if ch and key not in seen_res and len(seen_res) < 200_000:
                    seen_res.add(key)
                    try:
                        num = int(rnum)
                    except ValueError:
                        num = None
                    try:
                        b = float(get('B_iso_or_equiv'))
                    except ValueError:
                        b = None
                    chain_data.setdefault(ch, []).append((num, icode, get('auth_comp_id') or get('label_comp_id'), b))
            chain = get('auth_asym_id') or get('label_asym_id')
            chains.add(chain)
            residues.add((chain, get('auth_seq_id') or get('label_seq_id')))
            models.add(get('pdbx_PDB_model_num') or '1')
            if group == 'HETATM':
                hetatms += 1
                het_names.add(get('auth_comp_id') or get('label_comp_id'))
            else:
                atoms += 1
    return {'atoms': atoms, 'hetatms': hetatms, 'n_chains': len([c for c in chains if c]),
            'chains': sorted(c for c in chains if c), 'n_residues': len(residues),
            'n_models': max(1, len(models)), 'het_groups': sorted(h for h in het_names if h)[:30],
            'method': method, 'resolution': resolution, 'alphafold': alphafold,
            'chain_detail': _chain_report(chain_data, alphafold)}


# ------------------------------------------------------------------ consultas desde la interfaz
def get_page(start, size):
    st = STATE
    end = min(st['lite'], start + size)
    rows = []
    off = st['phred_offset']
    for i in range(start, end):
        d = st['descs'][i]
        rows.append({'idx': i, 'id': d.split()[0] if d.split() else '', 'len': st['lens'][i],
                     'gc': round(st['gcs'][i], 2),
                     'qual': round(st['qms'][i] - off, 1) if st['kind'] == 'fastq' else None})
    return json.dumps({'rows': rows, 'total': st['lite']})


def get_record_detail(idx):
    st = STATE
    d = st['descs'][idx]
    out = {'idx': idx, 'id': d.split()[0] if d.split() else '', 'desc': d, 'len': st['lens'][idx],
           'gc': round(st['gcs'][idx], 2), 'alphabet': st['alphabet'], 'has_seq': idx < st['stored']}
    if out['has_seq']:
        seq = st['seqs'][idx]
        PREVIEW = 3000
        out['seq'] = seq[:PREVIEW]
        out['truncated'] = len(seq) > PREVIEW
        if st['alphabet'] != 'protein':
            tail = seq[-PREVIEW:]
            rc = revcomp(tail)
            out['revcomp'] = rc
            head = seq[:PREVIEW]
            out['frames'] = {'+1': translate(head), '+2': translate(head[1:]), '+3': translate(head[2:]),
                             '-1': translate(rc), '-2': translate(rc[1:]), '-3': translate(rc[2:])}
        if st['kind'] == 'fastq':
            q = st['quals'][idx]
            out['qual'] = q[:PREVIEW]
            out['qual_mean'] = round(st['qms'][idx] - st['phred_offset'], 1)
    return json.dumps(out)


def search_records(query):
    q = query.lower().strip()
    out = []
    for i, d in enumerate(STATE['descs']):
        if q in d.lower():
            out.append({'idx': i, 'id': d.split()[0] if d.split() else '', 'desc': d[:200], 'len': STATE['lens'][i]})
            if len(out) >= 500:
                break
    return json.dumps({'rows': out, 'capped': len(out) >= 500})


def _motif_pattern(motif, alphabet):
    m = re.sub(r'\s+', '', motif).upper()
    if not m:
        raise UserError('motif_empty')
    if alphabet == 'protein':
        if not re.fullmatch(r'[A-Z\*]+', m):
            raise UserError('motif_invalid')
        pat = ''.join('.' if ch == 'X' else re.escape(ch) for ch in m)
        return m, pat, None
    if any(ch not in IUPAC for ch in m):
        raise UserError('motif_invalid')
    fwd = ''.join(IUPAC[ch] for ch in m)
    rc_m = revcomp(m)
    rev = ''.join(IUPAC[ch] for ch in rc_m)
    return m, fwd, (None if rc_m.replace('U', 'T') == m.replace('U', 'T') else rev)


def motif_search(motif, both_strands=True):
    try:
        st = STATE
        m, fwd, rev = _motif_pattern(motif, st['alphabet'])
        rx_f = re.compile('(?=(' + fwd + '))', re.IGNORECASE)
        rx_r = re.compile('(?=(' + rev + '))', re.IGNORECASE) if (rev and both_strands) else None
        results = []
        total = 0
        seqs_with = 0
        for i in range(st['stored']):
            seq = st['seqs'][i]
            pos_f, pos_r = [], []
            nf = nr = 0
            for mt in rx_f.finditer(seq):
                nf += 1
                if len(pos_f) < 20:
                    pos_f.append(mt.start() + 1)
            if rx_r is not None:
                for mt in rx_r.finditer(seq):
                    nr += 1
                    if len(pos_r) < 20:
                        pos_r.append(mt.start() + 1)
            if nf or nr:
                seqs_with += 1
                total += nf + nr
                if len(results) < 300:
                    d = st['descs'][i]
                    results.append({'idx': i, 'id': d.split()[0] if d.split() else '', 'plus': nf, 'minus': nr,
                                    'pos_plus': pos_f, 'pos_minus': pos_r})
        return json.dumps({'motif': m, 'total': total, 'sequences': seqs_with, 'matches': results,
                           'palindrome': rev is None and st['alphabet'] != 'protein',
                           'searched': st['stored'], 'count': len(st['descs']),
                           'both_strands': bool(rx_r is not None or rev is None)})
    except UserError as e:
        return _err_json(e)


def export_selection(opts_json, out_path='/tmp/export.out'):
    """Recorre el archivo COMPLETO de nuevo (streaming) aplicando los filtros."""
    try:
        o = json.loads(opts_json)
        st = STATE
        min_len = int(o.get('min_len') or 0)
        max_len = int(o.get('max_len') or 0)
        kw = (o.get('keyword') or '').lower().strip()
        min_q = float(o.get('min_qual') or 0)
        max_ee = float(o.get('max_ee') or 0)
        to_fasta = o.get('format') == 'fasta'
        rc = bool(o.get('revcomp')) and st['alphabet'] != 'protein'
        gz = bool(o.get('gzip'))
        src, kind, lines, first = _open_records(st['path'], st['filename'])
        fh = gzip.open(out_path, 'wt', compresslevel=5) if gz else open(out_path, 'w')
        n = 0
        try:
            is_fq = st['kind'] == 'fastq'
            it = _iter_fastq(lines, first) if is_fq else ((d, s, None) for d, s in _iter_fasta(lines, first))
            off = st['phred_offset']
            buf = []
            for desc, seq, qual in it:
                L = len(seq)
                if L < min_len or (max_len and L > max_len):
                    continue
                if kw and kw not in desc.lower():
                    continue
                if is_fq and (min_q or max_ee):
                    qb = qual.encode('ascii', 'replace')
                    if min_q and (not L or (sum(qb) / L - off) < min_q):
                        continue
                    if max_ee and expected_errors(qb, off) > max_ee:
                        continue
                if rc:
                    seq = revcomp(seq)
                    if qual is not None:
                        qual = qual[::-1]
                n += 1
                if is_fq and not to_fasta:
                    buf.append(f'@{desc}\n{seq}\n+\n{qual}\n')
                else:
                    buf.append('>' + desc + '\n' + '\n'.join(seq[i:i + 70] for i in range(0, len(seq), 70)) + '\n')
                if len(buf) >= 5000:
                    fh.write(''.join(buf))
                    buf = []
            if buf:
                fh.write(''.join(buf))
        finally:
            fh.close()
            src.close()
        ext = 'fastq' if (st['kind'] == 'fastq' and not to_fasta) else 'fasta'
        return json.dumps({'count': n, 'ext': ext + ('.gz' if gz else '')})
    except UserError as e:
        return _err_json(e)


_reset()
