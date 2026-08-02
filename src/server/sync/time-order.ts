/** Compares source timestamps without depending on database or network modules. */
export function newerSource(hardcoverTime: string | null, grimmoryTime: string | null): "hardcover" | "grimmory" | null {
  if (!hardcoverTime || !grimmoryTime) return null;
  const hardcoverMs = Date.parse(hardcoverTime);
  const grimmoryMs = Date.parse(grimmoryTime);
  if (Number.isNaN(hardcoverMs) || Number.isNaN(grimmoryMs)) {
    return hardcoverTime >= grimmoryTime ? "hardcover" : "grimmory";
  }
  return hardcoverMs >= grimmoryMs ? "hardcover" : "grimmory";
}
