import json
from pathlib import Path
SEED = Path(__file__).parents[2] / 'db' / 'seed_data' / 'document_types.json'
DOCUMENT_TYPES = json.loads(SEED.read_text(encoding='utf-8'))
def classify_document(name: str, text: str) -> list[dict]:
    corpus = f'{name} {text}'.lower(); matches=[]
    for item in DOCUMENT_TYPES:
        score=sum(1 for keyword in item['keywords'] if keyword.lower() in corpus)
        if score: matches.append({'document_type':item['document_type'],'practice_areas':item['practice_areas'],'confidence':score / max(1,len(item['keywords']))})
    return sorted(matches, key=lambda x:x['confidence'], reverse=True)
