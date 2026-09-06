from collections import Counter
def build_gap_analysis(findings):
    by_area=Counter(f.practice_area_code for f in findings if f.status == 'open'); by_severity=Counter(f.severity for f in findings if f.status == 'open')
    return {'open_findings':sum(by_area.values()), 'by_practice_area':dict(by_area), 'by_severity':dict(by_severity)}
