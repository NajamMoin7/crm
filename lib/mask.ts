/** Sensitive-field masking for users who may know a record exists but not its contact details. */
export function maskEmail(email: string | null | undefined) {
  if (!email) return "—";
  const [user, domain] = email.split("@");
  if (!domain) return "•••";
  return `${user.slice(0, 1)}${"•".repeat(Math.max(2, Math.min(user.length - 1, 6)))}@${domain}`;
}

export function maskPhone(phone: string | null | undefined) {
  if (!phone) return "—";
  const digits = phone.replace(/\D/g, "");
  return `•••• ${digits.slice(-4)}`;
}

/** Payment references are already tokenised; we still only show the tail to non-finance users. */
export function maskReference(ref: string | null | undefined) {
  if (!ref) return "—";
  return ref.length <= 8 ? ref : `${ref.slice(0, 4)}…${ref.slice(-4)}`;
}
