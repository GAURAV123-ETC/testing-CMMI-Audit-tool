// One-off generator for reference_documents/IRP_dummy_data.xlsx — a sample
// IRP Incident Log used to manually/automatically verify the Issue Category
// gap-propagation feature (blank/null/whitespace/invalid category → one
// incident-level gap per Issue ID, flowing to PA Validation + AFR).
// Run with: node scripts/buildIrpDummyFixture.mjs
import * as XLSX from 'xlsx'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

const HEADERS = [
  'Issue ID', 'Status', 'Issue Category', 'Description', 'Priority', 'Owner', 'Recurrence',
  'Impact', 'Severity', 'Escalate To', 'Cause', 'NC Status', 'Response', 'Closure Criteria',
  'Final Resolution', 'Closure Approved By', 'MIR Report Issued', 'Incident Type',
  'Report Date & Time', 'Reported By', 'Root Cause', 'Close Date & Time', 'Client Remarks',
  'Urgency', 'SLA', 'SLA Status',
]

function row(id, category, overrides = {}) {
  const base = {
    'Issue ID': id, 'Status': 'Closed', 'Issue Category': category,
    'Description': `Sample description for ${id || 'unidentified issue'}`,
    'Priority': 'P3', 'Owner': 'Jane Doe', 'Recurrence': 'No',
    'Impact': 'Medium', 'Severity': 'Low', 'Escalate To': 'N/A', 'Cause': 'Configuration drift',
    'NC Status': 'Closed', 'Response': 'Acknowledged and triaged', 'Closure Criteria': 'Verified by owner',
    'Final Resolution': 'Restarted affected service', 'Closure Approved By': 'John Smith',
    'MIR Report Issued': 'No', 'Incident Type': 'Operational',
    'Report Date & Time': '01-Jan-2026 09:00', 'Reported By': 'Help Desk',
    'Root Cause': 'Misconfigured deployment', 'Close Date & Time': '01-Jan-2026 12:00',
    'Client Remarks': 'None', 'Urgency': 'Medium', 'SLA': '8 Hours', 'SLA Status': 'Met',
    ...overrides,
  }
  return HEADERS.map(h => base[h])
}

const rows = [
  HEADERS,
  row('INC-001', 'Software Errors'),                                  // Pass
  row('INC-002', ''),                                                 // Gap — blank
  row('INC-003', 'Network Outages'),                                  // Pass
  row('INC-004', ''),                                                 // Gap — blank (represents "null")
  row('INC-005', '   '),                                              // Gap — whitespace-only
  row('INC-006', 'Database Issue'),                                   // Gap — invalid/undefined category
  row('INC-007', 'Hardware Failures'),                                // Pass
  row('INC-008', 'User-reported Problems'),                           // Pass
  row('', ''),                                                        // No Issue ID — existing missing-ID rule applies; category still evaluated, not fabricated
]

const wb = XLSX.utils.book_new()
const ws = XLSX.utils.aoa_to_sheet(rows)
XLSX.utils.book_append_sheet(wb, ws, 'Incident Log')

const outPath = join(__dirname, '..', 'reference_documents', 'IRP_dummy_data.xlsx')
XLSX.writeFile(wb, outPath)
console.log('Wrote', outPath)
