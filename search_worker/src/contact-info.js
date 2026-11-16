// Strips help-desk emails, phone/DSN numbers and POCs from portal
// descriptions. Run by the worker's /submit sanitizer and scripts/af-merge.js.

// Labelled numbers (DSN, Comm, ...), NANP numbers, 1-8xx vanity numbers and
// bare 7-digit DSN numbers.
const EMAIL = /[\w.+'-]+@[\w-]+(?:\.[\w-]+)+|\bmailto:/i
const PHONE = new RegExp([
  String.raw`\b(?:DSN|Comm(?:ercial)?|COM|Tel(?:ephone)?|Phone|Fax|Toll-Free|Local)\b\s*(?:number\s+is\s+now\s+)?[:\-–]?\s*\(?\d{3}`,
  String.raw`(?:\b1[-. ])?\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b`,
  String.raw`\b1-8\d\d-[A-Z\d-]{7,}`,
  String.raw`(?<![\d.-])\d{3}[-.]\d{4}(?![\d.-])`,
].join('|'), 'i')

export const hasContactInfo = text => EMAIL.test(text) || PHONE.test(text)

// Phrases that start the contact boilerplate; everything from there is cut.
const LEAD = new RegExp(String.raw`(?:` + [
  String.raw`To gain access to this (?:application|system)`,
  String.raw`To address any inquir`,
  String.raw`For (?:support|problems|assistance|technical|customer service|access\b|\S+ access\b|questions|futher info|further info|more information about \S+, please contact)`,
  String.raw`For more information or issues`,
  String.raw`Users? (?:requiring assistance|should contact)`,
  String.raw`please contact`,
  String.raw`Contact (?:the|your|us)\b`,
  String.raw`Contact Info(?:rmation)?\s*:`,
  String.raw`Access Information\s*:`,
  String.raw`Points? of Contact`,
  String.raw`POCs?\s*:`,
  String.raw`If you (?:do not have|need|require|have any|are having|experience|have problems)`,
  String.raw`Hours of operation`,
  String.raw`Direct any concerns`,
  String.raw`To contact`,
  String.raw`Application (?:Owner|Technical Support)\s*(?:Name\s*)?:`,
  String.raw`Content Owner\s*:`,
  String.raw`Live Phone Help`,
  String.raw`Service Desk\s*:`,
  String.raw`Questions (?:about|regarding) this`,
  String.raw`Submit questions`,
].join('|') + `)`, 'i')

// Sentence ends, including "end.Next" with no space
const SENTENCE_END = /[.!?](?:\s+|(?=[A-Z][a-z]))/g

// The index where the sentence holding position i starts
const sentenceStart = (text, i) => {
  let start = 0
  for (const m of text.slice(0, i).matchAll(SENTENCE_END)) start = m.index + m[0].length
  return start
}

// Cuts from the first lead's sentence, then drops any sentence still holding
// an address or number. Returns '' when nothing is left.
export function stripContactInfo(text) {
  if (typeof text !== 'string') return text
  let out = text.replace(/\s+/g, ' ').trim()
  const lead = LEAD.exec(out)
  if (lead) {
    // Run-on text with no sentence break nearby: cut at the lead itself
    const start = sentenceStart(out, lead.index)
    out = out.slice(0, start > 0 && lead.index - start <= 80 ? start : lead.index).trim()
  }
  if (hasContactInfo(out)) {
    const sentences = []
    let from = 0
    for (const m of out.matchAll(SENTENCE_END)) {
      sentences.push(out.slice(from, m.index + 1))
      from = m.index + m[0].length
    }
    sentences.push(out.slice(from))
    out = sentences.filter(s => s.trim() && !hasContactInfo(s)).map(s => s.trim()).join(' ')
  }
  return out.replace(/[\s,;:–-]+$/, '').trim()
}
