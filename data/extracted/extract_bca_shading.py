import csv,json,re,hashlib
from pathlib import Path
import pymupdf

ROOT = Path(__file__).resolve().parents[2]
PDF = ROOT / 'data' / 'latest-source.pdf'
OUT = Path(__file__).resolve().parent
OUT.mkdir(exist_ok=True)
doc = pymupdf.open(PDF)

specs = {
    'C12': ('horizontal_projection','North & South',[42]),
    'C13': ('horizontal_projection','East & West',[43]),
    'C14': ('horizontal_projection','North-East & North-West',[44]),
    'C15': ('horizontal_projection','South-East & South-West',[45]),
    'C16': ('vertical_projection','North & South',[46]),
    'C17': ('vertical_projection','East & West',[47]),
    'C18': ('vertical_projection','North-East & North-West',[48]),
    'C19': ('vertical_projection','South-East & South-West',[49]),
    'C20': ('egg_crate','North & South',[50,51,52]),
    'C21': ('egg_crate','East & West',[53,54,55]),
    'C22': ('egg_crate','North-East & North-West',[56,57,58]),
    'C23': ('egg_crate','South-East & South-West',[59,60,61]),
}

def split(cell):
    return [x.strip() for x in (cell or '').splitlines() if x.strip()]

rows=[]
validation={}
for table,(device,orientation,pages) in specs.items():
    table_rows=[]
    for pn in pages:
        found=doc[pn-1].find_tables().tables
        if len(found)!=1:
            raise RuntimeError(f'{table} page {pn}: expected 1 table, got {len(found)}')
        data=found[0].extract()
        hdr=data[0]
        cols=data[1]
        lists=[split(c) for c in cols]
        lengths={len(x) for x in lists}
        if len(lengths)!=1:
            raise RuntimeError(f'{table} page {pn}: unequal columns {list(map(len,lists))}')
        n=lengths.pop()
        if device!='egg_crate':
            if n!=30: raise RuntimeError(f'{table} page {pn}: expected 30 rows, got {n}')
            angles=[int(re.sub(r'[^0-9]','',h)) for h in hdr[1:]]
            for i in range(n):
                ratio=float(lists[0][i])
                for j,angle in enumerate(angles):
                    table_rows.append({'table':table,'device':device,'orientation':orientation,'R1':lists[0][i] if device=='horizontal_projection' else '', 'R2':lists[0][i] if device=='vertical_projection' else '', 'inclination_deg':angle,'effective_SC':lists[j+1][i],'source_pdf_page':pn})
        else:
            if n!=27: raise RuntimeError(f'{table} page {pn}: expected 27 rows, got {n}')
            angles=[int(re.sub(r'[^0-9]','',h)) for h in hdr[2:]]
            for i in range(n):
                for j,angle in enumerate(angles):
                    table_rows.append({'table':table,'device':device,'orientation':orientation,'R1':lists[0][i],'R2':lists[1][i],'inclination_deg':angle,'effective_SC':lists[j+2][i],'source_pdf_page':pn})
    rows.extend(table_rows)
    expected=180 if device!='egg_crate' else 405
    if len(table_rows)!=expected: raise RuntimeError(f'{table}: expected {expected} long rows, got {len(table_rows)}')
    validation[table]={'device':device,'orientation':orientation,'pages':pages,'long_row_count':len(table_rows),'min_SC':min(float(r['effective_SC']) for r in table_rows),'max_SC':max(float(r['effective_SC']) for r in table_rows)}

csv_path=OUT/'bca-shading-tables-C12-C23.csv'
fields=['table','device','orientation','R1','R2','inclination_deg','effective_SC','source_pdf_page']
with csv_path.open('w',newline='',encoding='utf-8') as f:
    w=csv.DictWriter(f,fieldnames=fields); w.writeheader(); w.writerows(rows)

manifest={
 'source_pdf':'../latest-source.pdf',
 'source_pdf_sha256':hashlib.sha256(PDF.read_bytes()).hexdigest(),
 'csv_sha256':hashlib.sha256(csv_path.read_bytes()).hexdigest(),
 'source_title':doc.metadata.get('title'),
 'source_creation_date':doc.metadata.get('creationDate'),
 'pdf_page_count':len(doc),
 'extraction_method':'PyMuPDF find_tables; normalized to one row per ratio/angle/SC combination',
 'total_long_rows':len(rows),
 'tables':validation,
 'structural_expectations':{
   'C12-C19':'30 ratio rows (0.1..3.0) x 6 inclinations (0,10,20,30,40,50) = 180 values/table',
   'C20-C23':'9 R1 values (0.2..1.8) x 9 R2 values (0.2..1.8) x 5 inclinations (0,10,20,30,40) = 405 values/table'
 }
}
(OUT/'bca-shading-tables-C12-C23-manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
print(json.dumps(manifest,indent=2))
