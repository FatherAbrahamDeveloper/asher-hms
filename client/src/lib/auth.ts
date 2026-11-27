import { useApi } from "./query";

export type StaffUser = { id: string; email: string; firstName: string; lastName: string; name: string; jobTitle: string | null; mustChangePassword: boolean; roleNames: string[]; roleKeys: string[]; permissions: string[] };
export type GuestUser = { id: string; email: string; firstName: string; lastName: string; name: string; phone: string | null; emailVerifiedAt: string | null; guestId: string };

export function useStaffMe() {
  const q = useApi<{ user: StaffUser | null; unread?: number }>("/auth/staff/me", { staleTime: 30_000 });
  const user = q.data?.user ?? null;
  const can = (p: string) => !!user?.permissions.includes(p);
  return { ...q, user, can, canAny: (ps: string[]) => ps.some(can) };
}

export function useGuestMe() {
  const q = useApi<{ user: GuestUser | null; unread?: number }>("/auth/guest/me", { staleTime: 30_000 });
  return { ...q, user: q.data?.user ?? null, unread: q.data?.unread ?? 0 };
}
