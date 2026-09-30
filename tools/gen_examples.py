"""Genera los archivos de ejemplo de READMYFASTA en ./data (ejecutar desde la raíz del proyecto)."""
import random, gzip, math, pysam

random.seed(7)


def rnd(n, gc=0.5):
    return ''.join(random.choices('ACGT', weights=[(1 - gc) / 2, gc / 2, gc / 2, (1 - gc) / 2], k=n))


def fasta_text(recs):
    out = []
    for h, s in recs:
        out.append('>' + h)
        out += [s[j:j + 70] for j in range(0, len(s), 70)]
    return '\n'.join(out) + '\n'


# ---- FASTA de nucleótidos (región soft-masked, N y sitios EcoRI) ----
recs = []
for i in range(1, 41):
    L = random.randint(300, 2400)
    s = rnd(L, gc=random.uniform(0.35, 0.65))
    if i % 5 == 0:
        p = L // 3
        s = s[:p] + s[p:p + 120].lower() + s[p + 120:]
    if i % 7 == 0:
        p = L // 2
        s = s[:p] + 'GAATTC' + s[p + 6:]
    if i % 9 == 0:
        s = s[:50] + 'N' * 25 + s[75:]
    gene = random.choice(['BRCA1', 'TP53', 'EGFR', 'KRAS', 'control', 'GAPDH', 'ACTB', 'MYC'])
    recs.append((f'contig_{i:03d} gen={gene} muestra=A{(i % 4) + 1}', s))
txt = fasta_text(recs)
open('data/ejemplo.fasta', 'w').write(txt)
with gzip.open('data/ejemplo.fasta.gz', 'wt') as f:
    f.write(txt)

# ---- FASTA de proteínas ----
aa = 'ACDEFGHIKLMNPQRSTVWY'
prots = [(f'sp|P{10000 + i}|PROT{i}_HUMAN Proteina de ejemplo {i}',
          'M' + ''.join(random.choices(aa, k=random.randint(120, 600)))) for i in range(12)]
open('data/ejemplo_proteinas.fasta', 'w').write(fasta_text(prots))

# ---- FASTQ.gz Illumina (Phred+33), multi-miembro, con lecturas de una referencia real ----
# Las lecturas se muestrean de un "genoma" sintético de 120 kb para que el espectro de k-meros
# tenga un pico de cobertura y la estimación de tamaño de genoma sea demostrable.
ADAPT = 'AGATCGGAAGAGCACACGTCTGAACTCCAGTCA'
REF = rnd(120_000, gc=0.47)
COMP = str.maketrans('ACGT', 'TGCA')
lines = []
previas = []
for i in range(8000):
    L = 150
    if i % 47 == 0 and previas:                      # duplicados de PCR
        s_read = random.choice(previas)
    else:
        p = random.randrange(0, len(REF) - L)
        s_read = REF[p:p + L]
        if i % 2:
            s_read = s_read.translate(COMP)[::-1]
        s_read = ''.join(c if random.random() > 0.002 else random.choice('ACGT') for c in s_read)
        if len(previas) < 400:
            previas.append(s_read)
    ins = random.randint(90, 400)
    if ins < L:                                      # inserto corto: aparece el adaptador
        s_read = (s_read[:ins] + ADAPT + rnd(L))[:L]
    if i % 70 == 0:                                  # cola poly-G (química de dos colores)
        s_read = s_read[:L - 20] + 'G' * 20
    q = []
    for pos in range(L):
        mu = 37 - (pos / L) ** 2 * 12
        q.append(max(2, min(41, int(random.gauss(mu, 3)))))
    if i % 50 == 0:
        q = [max(2, x - 15) for x in q]
    if i % 61 == 0:                                  # una tile concreta con mala calidad
        tile, q = 1203, [max(2, x - 12) for x in q]
    else:
        tile = 1101 + (i % 4)
    lane = 1 + (i % 2)
    idx = 'ACGTACGT' if i % 97 else 'ACGTACGA'       # contaminación leve de índice
    filtro = 'Y' if i % 311 == 0 else 'N'
    lines.append(f'@A00123:45:HXYZ:{lane}:{tile}:{1000 + i}:{2000 + i} 1:{filtro}:0:{idx}\n{s_read}\n+\n'
                 + ''.join(chr(x + 33) for x in q) + '\n')
blob = b''
for k in range(0, len(lines), 1000):
    blob += gzip.compress(''.join(lines[k:k + 1000]).encode())
open('data/ejemplo.fastq.gz', 'wb').write(blob)

# ---- CSV estilo DESeq2 exportado desde Excel en español (; y coma decimal, BOM, CRLF) ----
fmt = lambda x: f'{x:.4g}'.replace('.', ',')
rows = ['gen;baseMean;log2FoldChange;lfcSE;pvalue;padj']
for i in range(1500):
    lfc = random.gauss(0, 1.3)
    p = min(1.0, math.exp(-abs(lfc) * random.uniform(1, 7)))
    padj = min(1.0, p * random.uniform(1, 4))
    rows.append(f'GEN{i:04d};{fmt(random.uniform(5, 5000))};{fmt(lfc)};{fmt(random.uniform(.1, .6))};{fmt(p)};{fmt(padj)}')
open('data/ejemplo_resultados.csv', 'w', encoding='utf-8-sig', newline='').write('\r\n'.join(rows) + '\r\n')

# ---- TSV de metadatos ----
t = ['muestra\tcondicion\tedad\tcobertura_media\tlote']
for i in range(1, 25):
    t.append(f'A{i}\t{random.choice(["control", "tratado"])}\t{random.randint(20, 80)}\t{random.uniform(20, 60):.1f}\tL{random.randint(1, 3)}')
open('data/ejemplo_metadatos.tsv', 'w').write('\n'.join(t) + '\n')

# ---- PDB sintético estilo AlphaFold (hélice ideal; B-factor = pLDDT) ----
res3 = ['ALA', 'LEU', 'GLU', 'LYS', 'ARG', 'GLN', 'MET', 'SER', 'VAL', 'ILE']
pdb = ['TITLE     EJEMPLO SINTETICO ESTILO ALPHAFOLD (NO ES UNA ESTRUCTURA REAL)',
       'REMARK   1 HELICE IDEAL GENERADA PARA PROBAR READMYFASTA; B-FACTOR = PLDDT']
serial = 1
for chain, nres in (('A', 40), ('B', 28)):
    ox = 0 if chain == 'A' else 22
    for r in range(nres):
        if chain == 'B' and 11 <= r <= 14:      # residuos 12-15 sin resolver: hueco en la cadena
            continue
        ang = math.radians(100 * r)
        z = 1.5 * r
        plddt = max(20, min(98, 94 - abs(r - nres / 2) * 2.6 + random.uniform(-3, 3)))
        name = res3[r % len(res3)]
        for atom, rad, dang, dz, el in (('N', 1.55, -28, -0.9, 'N'), ('CA', 2.3, 0, 0, 'C'),
                                         ('C', 1.65, 28, 0.9, 'C'), ('O', 2.3, 40, 1.6, 'O')):
            a = ang + math.radians(dang)
            # eje de la hélice sobre X para que el visor la muestre de lado
            x, y, zz = z + dz - 30, ox + rad * math.cos(a) - 11, rad * math.sin(a)
            pdb.append(f'ATOM  {serial:5d} {atom:<4s} {name} {chain}{r + 1:4d}    {x:8.3f}{y:8.3f}{zz:8.3f}  1.00{plddt:6.2f}           {el}')
            serial += 1
    pdb.append(f'TER   {serial:5d}      {name} {chain}{nres:4d}')
    serial += 1
pdb.append(f'HETATM{serial:5d} ZN    ZN C   1      -5.000   0.000   0.000  1.00 90.00          ZN')
pdb.append('END')
open('data/ejemplo_estructura.pdb', 'w').write('\n'.join(pdb) + '\n')

# ---- BAM ordenado + índice .bai ----
hdr = {'HD': {'VN': '1.6', 'SO': 'coordinate'},
       'SQ': [{'SN': 'chrEjemplo', 'LN': 20000}, {'SN': 'plasmido', 'LN': 5000}],
       'RG': [{'ID': 'rg1', 'SM': 'muestra_A1'}], 'PG': [{'ID': 'bwa', 'PN': 'bwa', 'VN': '0.7.17'}]}
reads = []
for i in range(3000):
    tid = 0 if i % 5 else 1
    L = 20000 if tid == 0 else 5000
    a = pysam.AlignedSegment()
    a.query_name = f'lectura_{i}'
    a.query_sequence = rnd(150)
    a.flag = 1024 if i % 30 == 0 else 0
    if i % 97 == 0:
        a.flag = 4
    if a.flag == 4:
        a.reference_id, a.reference_start, a.mapping_quality = -1, -1, 0
    else:
        a.reference_id, a.reference_start = tid, random.randint(0, L - 151)
        a.mapping_quality = random.choice([60, 60, 60, 20, 3])
        a.cigarstring = '150M'
    a.query_qualities = pysam.qualitystring_to_array('I' * 150)
    a.set_tag('RG', 'rg1')
    reads.append(a)
with pysam.AlignmentFile('/tmp/unsorted.bam', 'wb', header=hdr) as out:
    for a in reads:
        out.write(a)
pysam.sort('-o', 'data/ejemplo_alineamientos.bam', '/tmp/unsorted.bam')
pysam.index('data/ejemplo_alineamientos.bam')
print(pysam.flagstat('data/ejemplo_alineamientos.bam'))
