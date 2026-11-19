// A finding that describes an error a user hits (a page, request or component that breaks) is never minor advice.
// The reviewer and the PR check judge are told so; this is the harness's backstop when one still files it as minor
// (council C3: a review recorded "a missing record throws and breaks the whole page" as minor, approved, and the
// error shipped). The match is on the finding's own words.
const PATTERNS = [
  /\bbreaks?\s+(?:the\s+)?(?:whole\s+|entire\s+)?(?:[\w-]+[\s/])?(?:page|header|site|screen|view|component|app|ui|request|response)\b/i,
  /\berror\s+page\b/i,
  /\bcrash(?:es|ed|ing)?\b/i,
  /\b(?:unhandled|uncaught)\b[^.]{0,40}(?:exception|error|rejection)\b/i,
  /\b(?:returns?|responds?\s+with|gives?)\s+(?:an?\s+)?(?:http\s+)?5\d\d\b/i,
];

export const describesUserError = (text) => PATTERNS.some((re) => re.test(String(text ?? '')));

// Council C4: a review filed "writes need only an authenticated caller, not an admin role" as minor, against a ticket
// whose Expected said admin role, and the PR check's critics took the implementer's notes as accepting it. A finding
// that says access is weaker than required is an unmet criterion and a security defect: blocking, never minor.
const AUTHZ = [
  /\b(?:any|only\s+an?|just\s+an?|merely\s+an?)\s+(?:authenticated|signed[-\s]in|logged[-\s]in)\s+(?:caller|user|client|request|principal)s?\b/i,
  /\bnot\s+(?:an?\s+|the\s+)?admin(?:istrator)?(?:\s+role)?\b/i,
  /\b(?:missing|lacks?|without|no)\s+(?:an?\s+|the\s+)?(?:admin(?:istrator)?\s+role|role\s+check|authori[sz]ation(?:\s+(?:check|policy))?|ownership\s+check|permission\s+check)\b/i,
  /\b(?:privilege\s+escalation|authori[sz]ation\s+(?:bypass|gap)|weaker\s+(?:authori[sz]ation|access\s+control))\b/i,
  /\b(?:another|other)\s+(?:user|buyer|customer)'?s\s+(?:order|basket|cart|data|account)s?\b[^.]{0,60}\b(?:can|could|is|are)\b/i,
];
export const describesWeakerAuthz = (text) => AUTHZ.some((re) => re.test(String(text ?? '')));

const textOf = (f) => [f.issue, f.title, f.detail, f.reason].filter(Boolean).join(' ');

// Returns the findings with every `minor` one that describes a user-visible error raised to `to`, and the raised ones.
export function raiseUserErrors(findings, { to, from = 'minor' } = {}) {
  const raised = [];
  const out = (findings ?? []).map((f) => {
    if (f?.severity !== from) return f;
    const authz = describesWeakerAuthz(textOf(f));
    if (!authz && !describesUserError(textOf(f))) return f;
    const r = { ...f, severity: to, raisedBy: 'harness', raisedReason: authz ? `filed as ${from}, but it says access is weaker than required; an authorization rule weaker than the ticket's is never ${from}` : `filed as ${from}, but it describes an error a user hits; such an error is never ${from}` };
    raised.push(r);
    return r;
  });
  return { findings: out, raised };
}
