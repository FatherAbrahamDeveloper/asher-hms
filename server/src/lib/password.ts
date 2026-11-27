import bcrypt from "bcryptjs";

export async function hashPassword(plain: string) {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain: string, hash: string) {
  return bcrypt.compare(plain, hash);
}

/** Basic strength rules: length, letters and numbers. */
export function passwordProblems(pw: string, minLength = 8): string | null {
  if (pw.length < minLength) return `Password must be at least ${minLength} characters.`;
  if (pw.length > 128) return "Password is too long.";
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return "Password must contain letters and numbers.";
  return null;
}
