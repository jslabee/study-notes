// Material titles may start with a numbering prefix such as "2. " or "3) ";
// the prefix is ignored when titles are compared, as is letter case
export function normalizeTitle(title) {
  return title.trim().replace(/^\d+[.)]\s+/, '').toLowerCase();
}

export function sameTitle(a, b) {
  return normalizeTitle(a) === normalizeTitle(b);
}
