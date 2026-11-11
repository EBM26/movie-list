// Small helpers shared by the Pages Functions.
export function parseId(params) {
  const id = Number(params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}
