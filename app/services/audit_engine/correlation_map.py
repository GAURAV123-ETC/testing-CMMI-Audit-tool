def correlation_map(findings):
    result={}
    for finding in findings: result.setdefault(finding.practice_area_code, []).append({'id':finding.id,'rule_id':finding.rule_id,'title':finding.title})
    return result
