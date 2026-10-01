// One error type for every service and route: an HTTP status and a message
// the caller may show. Shared constants for inputs the services accept.
class ServiceError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;
const isIsoDate = v => typeof v === 'string' && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v));
const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);

module.exports = { ServiceError, ISO_DATE, ACCESSION, isIsoDate, daysBetween };
