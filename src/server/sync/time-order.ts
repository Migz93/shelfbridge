/** Compares source timestamps without depending on database or network modules. */
export function newerSource(hardcoverTime: string | null, grimmoryTime: string | null): "hardcover" | "grimmory" | null {
  if (!hardcoverTime || !grimmoryTime) return null;
  const hardcoverMs = Date.parse(hardcoverTime);
  const grimmoryMs = Date.parse(grimmoryTime);
  // An unparseable timestamp can't be ordered meaningfully — lexicographic
  // string comparison would treat it as a real date and could flip the
  // outcome arbitrarily. Prefer whichever side actually parsed; if neither
  // did, there's no valid signal either way.
  if (Number.isNaN(hardcoverMs) && Number.isNaN(grimmoryMs)) return null;
  if (Number.isNaN(hardcoverMs)) return "grimmory";
  if (Number.isNaN(grimmoryMs)) return "hardcover";
  return hardcoverMs >= grimmoryMs ? "hardcover" : "grimmory";
}
