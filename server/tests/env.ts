import "dotenv/config";
// Tests run against a separate database (<name>_test) so they never touch real hotel data.
function testUrl(raw: string) {
  const u = new URL(raw);
  if (!u.pathname.endsWith("_test")) u.pathname = `${u.pathname}_test`;
  return u.toString();
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? testUrl(process.env.DATABASE_URL!);
process.env.DATA_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");
export { testUrl };
