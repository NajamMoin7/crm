/**
 * "Paste details": turns copied customer / order text into form fields.
 * Works with labelled text ("Email: …", "Zip code - …") and with loose text
 * (first line = name, any email / phone found anywhere).
 *
 * Card data is never accepted: card-number-like digit runs, CVV/CVC and
 * expiry values are stripped before parsing and reported via `removedCardData`.
 */

export type PastedOrder = {
  firstName?: string;
  lastName?: string;
  company?: string;
  email?: string;
  phone?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  amount?: string;
  description?: string;
  invoiceNumber?: string;
};

export type ParseResult = { fields: PastedOrder; removedCardData: boolean; matched: number };

const LABELS: [RegExp, keyof PastedOrder | "name"][] = [
  [/^(first\s*name|given\s*name|fname)$/i, "firstName"],
  [/^(last\s*name|surname|family\s*name|lname)$/i, "lastName"],
  [/^(full\s*name|name|customer(\s*name)?|card\s*holder(\s*name)?|cardholder(\s*name)?|client(\s*name)?|contact(\s*name)?)$/i, "name"],
  [/^(company|business|company\s*name|organi[sz]ation)$/i, "company"],
  [/^(e-?mail|email\s*address)$/i, "email"],
  [/^(phone|phone\s*number|tel|telephone|mobile|cell|contact\s*number)$/i, "phone"],
  [/^(address|address\s*(line)?\s*1|street|street\s*address|billing\s*address)$/i, "address1"],
  [/^(address\s*(line)?\s*2|address\s*\(cont\.?\)|apt|suite|unit)$/i, "address2"],
  [/^(city|town)$/i, "city"],
  [/^(state|province|region|state\s*\/\s*province)$/i, "state"],
  [/^(zip|zip\s*code|postal\s*code|postcode|post\s*code)$/i, "zip"],
  [/^(country)$/i, "country"],
  [/^(amount|total|price|charge|amount\s*to\s*charge)$/i, "amount"],
  [/^(description|item|product|service|order|details)$/i, "description"],
  [/^(invoice|invoice\s*(number|no\.?|#)|inv\.?\s*(no\.?|#)?)$/i, "invoiceNumber"],
];

const CARD_LABEL = /^(card(\s*(number|no\.?|#))?|cc|credit\s*card(\s*number)?|cvv|cvc|cid|security\s*code|exp(iry|iration)?(\s*date)?|valid\s*thru)$/i;

/** 13–19 digits, optionally separated by spaces or dashes. A fresh regex per use avoids shared lastIndex state. */
const cardRun = (flags = "") => new RegExp("\\b(?:\\d[ -]?){12,18}\\d\\b", flags);

export function parsePastedOrder(raw: string): ParseResult {
  let removedCardData = false;
  const lines = raw
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => {
      const m = /^([A-Za-z][A-Za-z0-9 ./#()-]{0,40}?)\s*[:=\-–—|]\s*(.*)$/.exec(l);
      if (m && CARD_LABEL.test(m[1].trim())) {
        removedCardData = true;
        return false;
      }
      return true;
    })
    .map((l) => {
      if (cardRun().test(l)) {
        removedCardData = true;
        return l.replace(cardRun("g"), " ").trim();
      }
      return l;
    })
    .filter(Boolean);

  const fields: PastedOrder = {};
  let matched = 0;
  const loose: string[] = [];
  let name: string | undefined;

  for (const line of lines) {
    const m = /^([A-Za-z][A-Za-z0-9 ./#()-]{0,40}?)\s*[:=\-–—|]\s*(.+)$/.exec(line);
    const key = m ? LABELS.find(([re]) => re.test(m[1].trim()))?.[1] : undefined;
    if (m && key) {
      const value = m[2].trim();
      if (!value) continue;
      if (key === "name") name = value;
      else if (!fields[key]) fields[key] = value;
      matched++;
    } else {
      loose.push(line);
    }
  }

  const all = lines.join("\n");
  if (!fields.email) {
    const e = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.exec(all);
    if (e) {
      fields.email = e[0];
      matched++;
    }
  }
  if (!fields.phone) {
    for (const cand of all.match(/\+?\(?\d[\d\s().-]{5,}\d/g) ?? []) {
      const digits = cand.replace(/\D/g, "");
      if (digits.length >= 7 && digits.length <= 15 && !/^\d{4}-\d{2}-\d{2}$/.test(cand.trim())) {
        fields.phone = cand.trim();
        matched++;
        break;
      }
    }
  }
  if (!fields.amount) {
    const a = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/.exec(all);
    if (a) fields.amount = a[1];
  }
  if (fields.amount) fields.amount = fields.amount.replace(/[$,\s]|USD/gi, "");
  if (fields.email) fields.email = fields.email.toLowerCase();

  // Loose text: the first line that looks like a person's name.
  if (!name && !fields.firstName) {
    name = loose.find((l) => /^[A-Za-z][A-Za-z' .-]{1,60}$/.test(l) && l.split(/\s+/).length <= 4 && !/@/.test(l));
    if (name) matched++;
  }
  if (name && !fields.firstName && !fields.lastName) {
    const parts = name.replace(/\s+/g, " ").trim().split(" ");
    fields.firstName = parts.length > 1 ? parts.slice(0, -1).join(" ") : parts[0];
    if (parts.length > 1) fields.lastName = parts[parts.length - 1];
  }
  // "City, ST 12345" on one loose line
  if (!fields.city) {
    const c = loose.map((l) => /^([A-Za-z .'-]+),\s*([A-Za-z .]{2,})\s+(\d{4,10}(?:-\d{4})?)$/.exec(l)).find(Boolean);
    if (c) {
      fields.city = c[1].trim();
      fields.state ??= c[2].trim();
      fields.zip ??= c[3];
      matched++;
    }
  }
  return { fields, removedCardData, matched };
}
