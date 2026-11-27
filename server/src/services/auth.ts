import { prisma, type Tx } from "../lib/db";
import { audit, auditStandalone, type Actor } from "../lib/audit";
import { hashPassword, passwordProblems, verifyPassword } from "../lib/password";
import { randomToken, sha256 } from "../lib/crypto";
import { AppError } from "../lib/errors";
import { notifyStaff, queueDelivery } from "../lib/notify";
import { getSettings } from "../lib/settings";

type Meta = { ip: string | null; userAgent: string | null };

export type LoginResult = { ok: true; userId: string; mustChangePassword: boolean } | { ok: false; message: string };

/**
 * Verify credentials with lockout after repeated failures (per account identifier and per IP).
 * Every attempt is recorded in LoginAttempt and the audit log.
 */
export async function authenticate(emailRaw: string, password: string, portal: "STAFF" | "GUEST", meta: Meta): Promise<LoginResult> {
  const email = emailRaw.trim().toLowerCase();
  const settings = await getSettings();
  const since = new Date(Date.now() - settings.security.lockoutMinutes * 60_000);
  const [byIdentifier, byIp] = await Promise.all([
    prisma.loginAttempt.count({ where: { identifier: email, portal, success: false, createdAt: { gte: since } } }),
    meta.ip ? prisma.loginAttempt.count({ where: { ipAddress: meta.ip, success: false, createdAt: { gte: since } } }) : Promise.resolve(0),
  ]);
  const actorBase: Actor = { userId: null, name: email, role: null, ip: meta.ip, userAgent: meta.userAgent, type: portal };

  if (byIdentifier >= settings.security.maxFailedLogins || byIp >= settings.security.maxFailedLogins * 4) {
    await prisma.loginAttempt.create({ data: { identifier: email, portal, success: false, reason: "LOCKED_OUT", ipAddress: meta.ip, userAgent: meta.userAgent?.slice(0, 300) } });
    await auditStandalone(actorBase, { action: "auth.login_blocked", module: "security", newValues: { email, portal }, outcome: "DENIED" });
    return { ok: false, message: `Too many failed attempts. Try again in ${settings.security.lockoutMinutes} minutes.` };
  }

  const user = await prisma.user.findUnique({ where: { email }, include: { roles: { include: { role: true } } } });
  const valid = !!user && user.type === portal && (await verifyPassword(password, user.passwordHash));
  // Constant-ish work even when user not found
  if (!user) await verifyPassword(password, "$2a$12$abcdefghijklmnopqrstuuVkjE8Q8L0FzbVZsZ9N0jC7yYy8y8y8y");

  if (!valid || !user.isActive) {
    const reason = !user ? "UNKNOWN_USER" : !valid ? "BAD_PASSWORD" : "INACTIVE";
    await prisma.loginAttempt.create({ data: { identifier: email, portal, userId: user?.id, success: false, reason, ipAddress: meta.ip, userAgent: meta.userAgent?.slice(0, 300) } });
    await auditStandalone({ ...actorBase, userId: user?.id ?? null }, { action: "auth.login_failed", module: "security", recordType: "User", recordId: user?.id, newValues: { email, portal, reason }, outcome: "FAILURE" });
    if (portal === "STAFF" && byIdentifier + 1 === settings.security.maxFailedLogins) {
      await notifyStaff(prisma, ["staff.manage"], {
        category: "security", priority: "HIGH", title: "Staff account locked after failed logins",
        body: `${settings.security.maxFailedLogins} failed sign-in attempts for ${email}${meta.ip ? ` from ${meta.ip}` : ""}.`,
        link: "/manage/audit?module=security", dedupeKey: `lockout:${email}:${since.toISOString().slice(0, 13)}`,
      });
    }
    if (user && user.type !== portal && (await verifyPassword(password, user.passwordHash))) {
      return { ok: false, message: user.type === "STAFF" ? "This is a staff account. Sign in at /manage/login instead." : "This is a guest account. Sign in on the main website instead." };
    }
    return { ok: false, message: !valid ? "Incorrect email or password." : "This account has been deactivated. Contact the hotel administrator." };
  }

  await prisma.$transaction(async (tx) => {
    await tx.loginAttempt.create({ data: { identifier: email, portal, userId: user.id, success: true, ipAddress: meta.ip, userAgent: meta.userAgent?.slice(0, 300) } });
    await audit(tx, { userId: user.id, name: `${user.firstName} ${user.lastName}`, role: user.roles.map((r) => r.role.name).join(", ") || (portal === "GUEST" ? "guest" : null), ip: meta.ip, userAgent: meta.userAgent, type: portal }, {
      action: "auth.login", module: "security", recordType: "User", recordId: user.id,
    });
  });
  return { ok: true, userId: user.id, mustChangePassword: user.mustChangePassword };
}

export async function registerGuest(input: { firstName: string; lastName: string; email: string; phone: string; password: string }, meta: Meta) {
  const email = input.email.trim().toLowerCase();
  const settings = await getSettings();
  const problem = passwordProblems(input.password, settings.security.passwordMinLength);
  if (problem) throw new AppError(problem);
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new AppError("An account with this email already exists. Try signing in or resetting your password.");
  const passwordHash = await hashPassword(input.password);

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { type: "GUEST", email, phone: input.phone, passwordHash, firstName: input.firstName, lastName: input.lastName, notificationPrefs: { email: true, sms: true } },
    });
    // Link to an existing guest record created by staff (same email, no account yet), otherwise create one.
    const match = await tx.guest.findFirst({ where: { email: { equals: email, mode: "insensitive" }, userId: null, deletedAt: null } });
    const guest = match
      ? await tx.guest.update({ where: { id: match.id }, data: { userId: user.id, phone: match.phone ?? input.phone } })
      : await tx.guest.create({ data: { userId: user.id, firstName: input.firstName, lastName: input.lastName, email, phone: input.phone } });
    const actor: Actor = { userId: user.id, name: `${input.firstName} ${input.lastName}`, role: "guest", ip: meta.ip, userAgent: meta.userAgent, type: "GUEST", guestId: guest.id };
    await audit(tx, actor, { action: "guest.register", module: "guests", recordType: "Guest", recordId: guest.id, newValues: { email, phone: input.phone, linkedExisting: !!match } });
    await createEmailVerification(tx, user.id, email, input.firstName);
    return { user, guest };
  });
}

async function createEmailVerification(tx: Tx, userId: string, email: string, firstName: string) {
  const token = randomToken();
  await tx.emailVerificationToken.create({ data: { userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 48 * 3600_000) } });
  await queueDelivery(tx, {
    channel: "EMAIL", recipient: email, subject: "Verify your email — Asher Hotel and Suites",
    body: `Dear ${firstName},\n\nPlease verify your email address:\n${process.env.APP_URL ?? ""}/verify-email?token=${token}\n\nThis link expires in 48 hours.`,
  });
}

export async function resendVerification(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.emailVerifiedAt) return;
  await prisma.$transaction((tx) => createEmailVerification(tx, user.id, user.email, user.firstName));
}

export async function verifyEmail(token: string) {
  const rec = await prisma.emailVerificationToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!rec || rec.usedAt || rec.expiresAt < new Date()) throw new AppError("This verification link is invalid or has expired.");
  await prisma.$transaction([
    prisma.emailVerificationToken.update({ where: { id: rec.id }, data: { usedAt: new Date() } }),
    prisma.user.update({ where: { id: rec.userId }, data: { emailVerifiedAt: new Date() } }),
  ]);
}

/** Always behaves the same whether or not the account exists (no account enumeration). */
export async function requestPasswordReset(emailRaw: string, portal: "STAFF" | "GUEST", meta: Meta) {
  const email = emailRaw.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.type !== portal || !user.isActive) return;
  const recent = await prisma.passwordResetToken.count({ where: { userId: user.id, createdAt: { gte: new Date(Date.now() - 3600_000) } } });
  if (recent >= 3) return;
  const token = randomToken();
  await prisma.$transaction(async (tx) => {
    await tx.passwordResetToken.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 3600_000) } });
    await queueDelivery(tx, {
      channel: "EMAIL", recipient: email, subject: "Reset your password — Asher Hotel and Suites",
      body: `Dear ${user.firstName},\n\nUse this link to reset your password (valid for 1 hour):\n${process.env.APP_URL ?? ""}${portal === "STAFF" ? "/manage" : ""}/reset-password?token=${token}\n\nIf you did not request this, you can ignore this email.`,
    });
    await audit(tx, { userId: user.id, name: email, role: null, ip: meta.ip, userAgent: meta.userAgent, type: portal }, { action: "auth.password_reset_requested", module: "security", recordType: "User", recordId: user.id });
  });
}

export async function resetPassword(token: string, newPassword: string, meta: Meta) {
  const rec = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!rec || rec.usedAt || rec.expiresAt < new Date()) throw new AppError("This reset link is invalid or has expired. Please request a new one.");
  const settings = await getSettings();
  const problem = passwordProblems(newPassword, settings.security.passwordMinLength);
  if (problem) throw new AppError(problem);
  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction(async (tx) => {
    await tx.passwordResetToken.update({ where: { id: rec.id }, data: { usedAt: new Date() } });
    await tx.user.update({ where: { id: rec.userId }, data: { passwordHash, mustChangePassword: false } });
    await tx.session.updateMany({ where: { userId: rec.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(tx, { userId: rec.userId, name: rec.user.email, role: null, ip: meta.ip, userAgent: meta.userAgent, type: rec.user.type }, { action: "auth.password_reset", module: "security", recordType: "User", recordId: rec.userId });
  });
  return rec.user.type;
}

export async function changePassword(actor: Actor, current: string, next: string) {
  if (!actor.userId) throw new AppError("Not signed in.");
  const user = await prisma.user.findUniqueOrThrow({ where: { id: actor.userId } });
  if (!(await verifyPassword(current, user.passwordHash))) {
    await auditStandalone(actor, { action: "auth.password_change_failed", module: "security", recordType: "User", recordId: user.id, outcome: "FAILURE" });
    throw new AppError("Your current password is incorrect.");
  }
  const settings = await getSettings();
  const problem = passwordProblems(next, settings.security.passwordMinLength);
  if (problem) throw new AppError(problem);
  if (current === next) throw new AppError("Choose a password different from your current one.");
  const passwordHash = await hashPassword(next);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { passwordHash, mustChangePassword: false } });
    await audit(tx, actor, { action: "auth.password_changed", module: "security", recordType: "User", recordId: user.id });
  });
}
