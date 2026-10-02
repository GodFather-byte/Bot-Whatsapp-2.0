export function normalizePhoneNumber(value = '') {
  return value.split('@')[0].split(':')[0].replace(/\D/g, '');
}

export function createAllowlist(allowedNumbers = [], enabled = allowedNumbers.length > 0) {
  const allowed = new Set(allowedNumbers.map(normalizePhoneNumber).filter(Boolean));

  return {
    enabled,
    // Aceita vários identificadores do mesmo contato (JID, LID, número), já que o WhatsApp pode usar qualquer um.
    isAllowed(...ids) {
      return !enabled || ids.some((id) => id && allowed.has(normalizePhoneNumber(id)));
    }
  };
}
