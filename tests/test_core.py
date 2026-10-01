"""Pruebas del motor de READMYFASTA (Python estándar; se ejecutan con CPython, sin navegador).

    python -m pytest -q tests/test_core.py      # con pytest
    python tests/test_core.py                   # sin pytest
"""
import gzip
import json
import os
import random
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'src', 'py'))
import core  # noqa: E402
from fastq_extras import FastqExtras, expected_errors  # noqa: E402

DATA = os.path.join(ROOT, 'data')


def load(path, name=None):
    return json.loads(core.process_upload(path, name or os.path.basename(path)))


def write(tmp_path, name, content, mode='w', **kw):
    p = os.path.join(str(tmp_path), name)
    with open(p, mode, **kw) as f:
        f.write(content)
    return p


# ------------------------------------------------------------------ detección y robustez
def test_fasta_con_bom_y_crlf(tmp_path):
    p = write(tmp_path, 'bom.fa', '>s1 prueba\r\nACGTNNacgt\r\nGGCC\r\n>s2\r\nAAAA\r\n', encoding='utf-8-sig', newline='')
    r = load(p)
    assert r['summary']['count'] == 2
    rows = json.loads(core.get_page(0, 5))['rows']
    assert rows[0]['id'] == 's1' and rows[0]['len'] == 14


def test_secuencia_sin_cabecera(tmp_path):
    r = load(write(tmp_path, 'raw.txt', 'ACGTACGTACGTAAAATTTTGGGG\nACGT\n'))
    assert r['kind'] == 'sequence' and r['summary']['count'] == 1


def test_fastq_malformado(tmp_path):
    r = load(write(tmp_path, 'bad.fastq', '@r1\nACGT\n+\nIIII\n@r2\nACGT\nIIII\n+\n'))
    assert r['error'] == 'fastq_bad_plus' and r['info']['record'] == 2
    r = load(write(tmp_path, 'mm.fastq', '@r1\nACGT\n+\nIII\n'))
    assert r['error'] == 'fastq_len_mismatch'


def test_gzip_truncado(tmp_path):
    data = gzip.compress(open(os.path.join(DATA, 'ejemplo.fasta'), 'rb').read())
    r = load(write(tmp_path, 'trunc.fa.gz', data[:len(data) // 2], mode='wb'))
    assert r['error'] == 'gz_truncated'


def test_zip_y_vacio(tmp_path):
    p = os.path.join(str(tmp_path), 'x.zip')
    with zipfile.ZipFile(p, 'w') as z:
        z.writestr('a.fasta', '>a\nACGT\n')
    assert load(p)['error'] == 'zip'
    assert load(write(tmp_path, 'e.txt', ''))['error'] == 'empty'


def test_vcf_se_detecta(tmp_path):
    assert load(write(tmp_path, 'v.vcf', '##fileformat=VCFv4.2\n#CHROM\tPOS\n'))['error'] == 'is_vcf'


# ------------------------------------------------------------------ FASTA
def test_fasta_ejemplo():
    r = load(os.path.join(DATA, 'ejemplo.fasta'))
    s = r['summary']
    assert s['count'] == 40 and s['alphabet'] == 'dna'
    assert s['n50'] > 0 and s['l50'] > 0
    assert 0 < s['pct_softmasked'] < 5
    assert s['n_dup_ids'] == 0 and r['warnings'] == []


def test_proteinas():
    r = load(os.path.join(DATA, 'ejemplo_proteinas.fasta'))
    assert r['summary']['alphabet'] == 'protein'
    assert r['charts']['gc'] is None


def test_duplicados_fasta(tmp_path):
    r = load(write(tmp_path, 'd.fasta', '>g1 a\nACGTACGT\n>g1 b\nTTTT\n>g2\nACGTACGT\n>g3\nacgtACGT\n'))
    s = r['summary']
    assert s['n_dup_ids'] == 1 and s['dup_ids'][0] == {'id': 'g1', 'count': 2}
    assert s['dup_seq_extra'] == 2          # g2 y g3 repiten la secuencia de g1 (sin distinguir mayúsculas)
    assert {w['code'] for w in r['warnings']} == {'dup_ids', 'dup_seqs'}


# ------------------------------------------------------------------ motivos
def test_motivos_solapados_iupac_y_hebra_menos(tmp_path):
    load(write(tmp_path, 'ov.fa', '>a\nAAAAAA\n'))
    assert json.loads(core.motif_search('AA'))['total'] == 5            # solapamientos
    tt = json.loads(core.motif_search('TT'))
    assert tt['matches'][0]['minus'] == 5                                 # hebra complementaria
    load(os.path.join(DATA, 'ejemplo.fasta'))
    eco = json.loads(core.motif_search('GAATTC'))
    assert eco['palindrome'] and eco['total'] > 0
    assert json.loads(core.motif_search('XYZ'))['error'] == 'motif_invalid'
    assert json.loads(core.motif_search('NGG'))['total'] > eco['total']


# ------------------------------------------------------------------ FASTQ
def test_fastq_ejemplo_completo():
    r = load(os.path.join(DATA, 'ejemplo.fastq.gz'))
    s = r['summary']
    assert s['count'] == 8000 and s['phred_offset'] == 33
    assert 60 < s['pct_q30'] < 90
    assert 0 < s['ee_mean'] < 2
    assert s['polyg_pct'] > 1
    assert 100_000 < s['genome_size'] < 160_000                          # referencia real: 120 kb
    run = r['run']
    assert run['instruments'] == ['A00123'] and len(run['lanes']) == 2
    assert run['worst_tiles'][0]['tile'] == '1203'                        # la tile defectuosa del ejemplo
    assert [i['index'] for i in run['indexes']][:2] == ['ACGTACGT', 'ACGTACGA']
    codes = {w['code'] for w in r['warnings']}
    assert 'polyg' in codes


def test_phred64(tmp_path):
    r = load(write(tmp_path, 'q64.fq', '@r\nACGTACGTAC\n+\nhhhhhhhhhh\n'))
    assert r['summary']['phred_offset'] == 64
    assert {w['code'] for w in r['warnings']} >= {'phred64', 'ee_unavailable'}


def test_fastq_sin_cabecera_illumina(tmp_path):
    content = ''.join('@lectura_%d\nACGTACGTACGTACGTACGT\n+\nIIIIIIIIIIIIIIIIIIII\n' % i for i in range(500))
    r = load(write(tmp_path, 'simple.fastq', content))
    assert r['run'] is None
    assert r['kmers']['reason'] == 'few_reads' and r['kmers']['genome_size'] is None


def test_errores_esperados():
    assert abs(expected_errors(b'IIII') - 4 * 10 ** -4) < 1e-12         # 'I' = Q40
    assert abs(expected_errors(b'5') - 0.01) < 1e-12                     # '5' = Q20 → 1 error cada 100
    assert abs(expected_errors(b'+') - 0.1) < 1e-12                      # '+' = Q10 → 1 error cada 10


def test_estimacion_de_genoma():
    random.seed(3)
    genome = ''.join(random.choices('ACGT', k=150_000))
    comp = str.maketrans('ACGT', 'TGCA')
    ex = FastqExtras()
    n = 0
    for i in range(12000):
        p = random.randrange(0, len(genome) - 150)
        read = genome[p:p + 150]
        if i % 2:
            read = read.translate(comp)[::-1]
        n += 1
        ex.add(f'r{i}', read, b'I' * 150, n)
    k = ex.result(n, n * 150, 33)['kmers']
    assert 135_000 < k['genome_size'] < 165_000


def test_exportacion_por_ee_y_a_fasta(tmp_path):
    load(os.path.join(DATA, 'ejemplo.fastq.gz'))
    out = os.path.join(str(tmp_path), 'o.fa')
    r = json.loads(core.export_selection(json.dumps({'max_ee': 1, 'format': 'fasta'}), out))
    assert 7000 < r['count'] < 8000 and r['ext'] == 'fasta'
    assert open(out).read().startswith('>')


# ------------------------------------------------------------------ tablas
def test_csv_deseq2_coma_decimal():
    r = load(os.path.join(DATA, 'ejemplo_resultados.csv'))
    assert r['summary']['delimiter'] == ';' and r['summary']['n_rows'] == 1500
    assert r['de']['tool'] == 'DESeq2' and len(r['de']['points']) > 1000
    assert {w['code'] for w in r['warnings']} == {'decimal_comma'}


# ------------------------------------------------------------------ estructuras
def test_pdb_cadenas_y_huecos():
    r = load(os.path.join(DATA, 'ejemplo_estructura.pdb'))
    s = r['summary']
    assert s['alphafold'] and s['n_chains'] == 3
    chains = {c['chain']: c for c in s['chain_detail']}
    assert chains['A']['n_gaps'] == 0
    assert chains['B']['gaps'] == [{'after': 11, 'before': 16, 'missing': 4}]
    assert chains['A']['seq'].startswith('ALEKRQ')
    assert r['warnings'] == [{'code': 'chain_gaps', 'n': 4, 'chains': 1}]


def test_mmcif(tmp_path):
    cif = ("data_TEST\n_exptl.method 'X-RAY DIFFRACTION'\n_refine.ls_d_res_high 1.9\nloop_\n"
           "_atom_site.group_PDB\n_atom_site.id\n_atom_site.label_atom_id\n_atom_site.label_comp_id\n"
           "_atom_site.auth_asym_id\n_atom_site.auth_seq_id\n_atom_site.B_iso_or_equiv\n_atom_site.pdbx_PDB_model_num\n"
           "ATOM 1 CA ALA A 1 10.0 1\nATOM 2 CA GLY A 2 12.0 1\nATOM 3 CA SER A 5 11.0 1\nHETATM 4 O HOH B 50 20.0 1\n#\n")
    s = load(write(tmp_path, 's.cif', cif))['summary']
    assert s['method'] == 'X-RAY DIFFRACTION' and s['resolution'] == 1.9
    a = s['chain_detail'][0]
    assert a['seq'] == 'AGS' and a['missing_residues'] == 2


def _run_all():
    import tempfile
    import inspect
    failed = 0
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith('test_') and callable(f)]
    for name, fn in tests:
        try:
            if 'tmp_path' in inspect.signature(fn).parameters:
                with tempfile.TemporaryDirectory() as d:
                    fn(d)
            else:
                fn()
            print(f'  ok  {name}')
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f'  FALLO  {name}: {e!r}')
    print(f'{len(tests) - failed}/{len(tests)} pruebas correctas')
    return failed


if __name__ == '__main__':
    sys.exit(1 if _run_all() else 0)
