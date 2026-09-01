// ─── AI Service ───────────────────────────────────────────────────────────────
// Powered by the actual CMMI V3.0 model document (808 pages, 187 practices).
//
// TO UPGRADE TO A REAL AI PROVIDER:
//
// FOR CLAUDE (Anthropic):
//   1. npm install @anthropic-ai/sdk
//   2. Replace getAIResponse with:
//      import Anthropic from '@anthropic-ai/sdk'
//      const client = new Anthropic({ apiKey: 'YOUR_KEY', dangerouslyAllowBrowser: true })
//      export async function getAIResponse(userMessage) {
//        const kbContext = formatKBResponse(userMessage, searchKB(userMessage)) || ''
//        const msg = await client.messages.create({
//          model: 'claude-opus-4-6', max_tokens: 1024,
//          system: SYSTEM_PROMPT + '\n\nRelevant CMMI V3.0 model content:\n' + kbContext,
//          messages: [{ role: 'user', content: userMessage }]
//        })
//        return msg.content[0].text
//      }
//
// FOR OPENAI (ChatGPT):
//   1. npm install openai
//   2. Replace getAIResponse with:
//      import OpenAI from 'openai'
//      const client = new OpenAI({ apiKey: 'YOUR_KEY', dangerouslyAllowBrowser: true })
//      export async function getAIResponse(userMessage) {
//        const kbContext = formatKBResponse(userMessage, searchKB(userMessage)) || ''
//        const res = await client.chat.completions.create({
//          model: 'gpt-4o',
//          messages: [
//            { role: 'system', content: SYSTEM_PROMPT + '\n\nRelevant CMMI V3.0 model content:\n' + kbContext },
//            { role: 'user', content: userMessage }
//          ]
//        })
//        return res.choices[0].message.content
//      }
// ─────────────────────────────────────────────────────────────────────────────

import { CMMI_KB, searchKB, formatKBResponse } from './cmmiKB.js'

export const SYSTEM_PROMPT = `You are a CMMI Level 5 compliance expert with deep knowledge of CMMI V3.0 (808 pages). 
You answer questions directly from the CMMI model text. Always cite specific practice IDs (e.g. MPM 4.1, CAR 5.1).`

const AUDIT_CONTEXT = {
  score: 78,
  openAFRs: 11,
  criticalPAs: ['MPM', 'OPM'],
  org: 'TechCorp Inc.',
  year: 2025
}

const PA_FULL_NAMES = {
  CAR:'Causal Analysis and Resolution', CM:'Configuration Management',
  DAR:'Decision Analysis and Resolution', EST:'Estimating',
  GOV:'Governance', II:'Implementation Infrastructure',
  MC:'Monitor and Control',
  MPM:'Managing Performance and Measurement',
  OPD:'Organizational Process Definition',
  OPM:'Organizational Process Performance',
  PAD:'Process Asset Development', PCM:'Process Change Management',
  PDD:'Product and Product Component Development',
  PR:'Peer Reviews', RDM:'Requirements Development and Management',
  RSK:'Risk and Opportunity Management', SAM:'Supplier Agreement Management',
  TS:'Technical Solution',
  VV:'Verification and Validation', PLAN:'Planning', OT:'Organizational Training'
}

// ─── Response builder from KB ─────────────────────────────────────────────────

function buildKBAnswer(query) {
  const results = searchKB(query)
  if (!results.length) return null
  return formatKBResponse(query, results)
}

// ─── Structured responses for common audit questions ─────────────────────────

function answerFromKB(msg) {
  const m = msg.toLowerCase()

  // How many practice areas
  if ((m.includes('how many') || m.includes('number of')) && m.includes('practice area')) {
    const cats = CMMI_KB.general.pa_categories
    return `**CMMI V3.0 Practice Areas** *(from the CMMI V3.0 model)*\n\nCMMI V3.0 contains **${CMMI_KB.general.total_practice_areas} practice areas** across these categories:\n\n**Doing (project execution):** ${cats.Doing.join(', ')}\n\n**Managing (organizational):** ${cats.Managing.join(', ')}\n\n**Supporting:** ${cats.Supporting.join(', ')}\n\nYour current audit covers **19 of ${CMMI_KB.general.total_practice_areas}** practice areas. The remaining 5 (CONT, DM, DQ, ESAF, ESEC) are context-specific and pending scope confirmation.`
  }

  // What is CMMI
  if (m.includes('what is cmmi') || (m.includes('cmmi') && (m.includes('stand for') || m.includes('mean') || m.includes('explain cmmi')))) {
    return `**What is CMMI?** *(from CMMI V3.0 model, Part One)*\n\nCMMI stands for **Capability Maturity Model® Integration**. Published by ${CMMI_KB.general.publisher}, it is an integrated set of best practices that enable businesses to improve performance of their key business processes.\n\n**Current version:** ${CMMI_KB.general.version}\n**Total practice areas:** ${CMMI_KB.general.total_practice_areas}\n**Maturity levels:** 1 through 5\n\n${CMMI_KB.general.high_maturity_description}`
  }

  // Maturity levels
  if (m.includes('maturity level') || m.match(/level [1-5]/)) {
    const ml = CMMI_KB.general.maturity_levels
    return `**CMMI Maturity Levels** *(from CMMI V3.0 model)*\n\n${Object.entries(ml).map(([l,d]) => `**Level ${l}:** ${d}`).join('\n\n')}\n\n**Your status:** Score 78/100 ≈ Level 4.2. Critical gaps in MPM and OPM are blocking full Level 5.`
  }

  // Specific practice ID query e.g. "what is MPM 4.1"
  const practiceIdMatch = msg.match(/\b([A-Z]{2,5})\s+(\d+\.\d+)\b/)
  if (practiceIdMatch) {
    const code = practiceIdMatch[1]
    const pid = `${code} ${practiceIdMatch[2]}`
    const paData = CMMI_KB.practice_areas[code]
    if (paData && paData.practices[pid]) {
      const p = paData.practices[pid]
      let resp = `**${pid} — ${PA_FULL_NAMES[code] || code}** *(CMMI V3.0 model)*\n\n`
      if (p.statement) resp += `**Practice Statement:**\n${p.statement}\n\n`
      if (p.value) resp += `**Value:**\n${p.value}\n\n`
      if (p.explanation) resp += `**Further Explanation:**\n${p.explanation}\n\n`
      resp += `*Source: CMMI V3.0 Model, ${code} Practice Area*`
      return resp
    }
  }

  // PA overview query e.g. "explain MPM" or "what is CAR"
  const paMatch = msg.match(/\b(CAR|CM|DAR|EST|GOV|II|MC|MPM|OPD|OPM|PAD|PCM|PR|RDM|RSK|SAM|TS|VV|PLAN|OT)\b/)
  if (paMatch) {
    const code = paMatch[1]
    const paData = CMMI_KB.practice_areas[code]
    if (paData) {
      const practices = Object.entries(paData.practices)
      let resp = `**${code} — ${PA_FULL_NAMES[code] || code}** *(CMMI V3.0 model)*\n\n`
      if (paData.intent) resp += `**Intent:** ${paData.intent}\n\n`
      if (paData.intro) resp += `${paData.intro}\n\n`
      if (practices.length) {
        resp += `**Practices (${practices.length} total):**\n`
        practices.forEach(([pid, p]) => {
          resp += `• **${pid}**: ${(p.statement || '').substring(0, 120)}${p.statement?.length > 120 ? '...' : ''}\n`
        })
      }
      resp += `\n*Source: CMMI V3.0 Model, ${code} Practice Area*`
      return resp
    }
  }

  // Keyword search across all practices
  const kbResult = buildKBAnswer(msg)
  if (kbResult) {
    return kbResult + '\n\n*Source: CMMI V3.0 Model*'
  }

  return null
}

// ─── Fallback structured responses ───────────────────────────────────────────

const FALLBACKS = {
  qppo: `**Closing AFR-001: Quantitative Performance Objectives (QPPOs)**\n\nPer **MPM 4.1** (CMMI V3.0): *"${CMMI_KB.practice_areas?.MPM?.practices?.['MPM 4.1']?.statement || 'Establish quality and process performance objectives.'}"*\n\n**Step-by-step plan:**\n1. Define ≥3 QPPOs linked to business goals (e.g., defect escape rate < 2%)\n2. Collect 6–12 months historical data, compute mean and std deviation\n3. Document in Process Performance Baseline (PPB) — required by MPM 4.2\n4. Link each QPPO to a business objective per MPM 5.1\n\n**Artifacts to create:** QPPO Definition Document, Process Performance Baseline`,

  prioritize: `**Prioritized AFR Action Plan** *(based on CMMI V3.0 requirements)*\n\n🔴 **CRITICAL — Close within 30 days**\n1. AFR-001 (MPM 4.1): Define QPPOs — 1 week effort\n2. AFR-002 (OPM 4.2): Build Process Performance Models — 3–4 weeks\n\n🟡 **MAJOR — Close within 45 days**\n3. AFR-006 (RDM 3.2): Fix RTM traceability gaps — 1 week\n4. AFR-005 (GOV 2.2): Schedule monthly management reviews — 1 day\n5. AFR-007 (SAM 3.3): Quantify supplier SLAs — 2–3 weeks\n6. AFR-008 (PCM 3.2): Document impact analyses — 3 days\n\n🔵 **MINOR — Close within 60 days**\n7–9. AFR-009 (DAR), AFR-010 (PR), AFR-011 (II) — 1–3 days each`,
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function getAIResponse(userMessage) {
  await new Promise(r => setTimeout(r, 600 + Math.random() * 500))

  const m = userMessage.toLowerCase()

  // Try KB-grounded answer first
  const kbAnswer = answerFromKB(userMessage)
  if (kbAnswer) return kbAnswer

  // Fallback structured answers for common audit questions
  if (m.includes('qppo') || m.includes('afr-001')) return FALLBACKS.qppo
  if (m.includes('prioriti') || m.includes('action plan') || m.includes('open afr')) return FALLBACKS.prioritize

  // Generic fallback
  return `**CMMI V3.0 Guidance**\n\nI searched the CMMI V3.0 model for: *"${userMessage}"*\n\nI couldn't find an exact match in the model content. Try:\n• Using a specific practice ID (e.g. "MPM 4.1", "CAR 5.1")\n• Using a PA code (e.g. "explain MPM", "what is CAR")\n• Asking about maturity levels, QPPOs, PPBs, or specific AFRs\n\n*To get fully natural language answers on any CMMI question, connect a real AI backend — see the instructions at the top of \`src/aiService.js\`.*`
}
