import { Hono } from "hono";
import { db, call, type VccCard } from "../db/index";

const vccRouter = new Hono();

/** Generate a unique bigint ID based on timestamp + random bits */
function generateId(): bigint {
  return BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
}

vccRouter.get("/pool", async (c) => {
  const cards = db.vccCards.getAvailable();

  return c.json({
    count: cards.length,
    cards: cards.map((card) => {
      // Detect brand from card number
      const num = card.number.replace(/\D/g, "");
      let brand = "unknown";
      if (num.startsWith("4")) brand = "visa";
      else if (/^5[1-5]/.test(num) || /^2[2-7]/.test(num)) brand = "mastercard";
      else if (/^3[47]/.test(num)) brand = "amex";
      else if (/^6(?:011|5|22126|4[4-9])/.test(num)) brand = "discover";
      else if (/^35(?:2[89]|[3-8])/.test(num)) brand = "jcb";
      else if (/^62/.test(num)) brand = "unionpay";

      return {
        id: Number(card.id),
        last4: card.number.slice(-4),
        bin: card.number.slice(0, 6),
        brand,
        exp: `${card.expMonth}/${card.expYear.slice(-2)}`,
        name: card.name || "John Doe",
        status: card.status,
        createdAt: new Date(Number(card.createdAt)).toISOString(),
      };
    }),
  });
});

vccRouter.post("/pool", async (c) => {
  const body = await c.req.json<{ cards: { number: string; exp: string; cvv: string; name?: string }[] }>();
  if (!Array.isArray(body.cards)) {
    return c.json({ error: "cards must be an array" }, 400);
  }

  let added = 0;
  for (const card of body.cards) {
    if (!card.number || !card.exp || !card.cvv) continue;

    const number = card.number.replace(/[\s-]/g, "");
    let expMonth = "";
    let expYear = "";

    if (card.exp.includes("/")) {
      const parts = card.exp.split("/");
      expMonth = parts[0]!.trim().padStart(2, "0");
      expYear = parts[1]!.trim();
      if (expYear.length === 2) expYear = `20${expYear}`;
    }

    call.upsertVccCard({
      id: generateId(),
      number,
      expMonth,
      expYear,
      cvv: card.cvv,
      name: card.name || "John Doe",
      status: "active",
      usedByAccountId: null,
    });
    added++;
  }

  return c.json({ added });
});

vccRouter.delete("/pool/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "invalid id" }, 400);

  call.deleteVccCard({ id: BigInt(id) });
  return c.json({ deleted: true });
});

vccRouter.delete("/pool", async (c) => {
  const activeCards = db.vccCards.getAvailable();
  for (const card of activeCards) {
    call.deleteVccCard({ id: card.id });
  }
  return c.json({ cleared: true });
});

vccRouter.get("/transactions", async (c) => {
  // VCC transactions — read from stdb cache
  // Note: The old code did a JOIN with accounts. We replicate by looking up accounts.
  const allTransactions = [...(db as any).vccTransactions?.getAll?.() || []];
  // If vccTransactions isn't exposed on db, fall back to empty
  // The stdb has vccTransactions table but db/index.ts doesn't expose a helper for it.
  // We'll read directly from the stdb import if needed.
  let rows: any[] = [];
  try {
    const { stdb } = await import("../stdb/index");
    const txns = [...stdb.vccTransactions.iter()] as any[];
    txns.sort((a: any, b: any) => Number((b.createdAt || 0n) - (a.createdAt || 0n)));
    rows = txns.slice(0, 100).map((tx: any) => {
      const account = tx.accountId ? db.accounts.findById(tx.accountId) : undefined;
      return {
        id: Number(tx.id),
        accountId: tx.accountId != null ? Number(tx.accountId) : null,
        cardLast4: tx.cardLast4,
        cardBrand: tx.cardBrand ?? null,
        status: tx.status,
        createdAt: tx.createdAt ? new Date(Number(tx.createdAt)).toISOString() : null,
        email: account?.email ?? null,
      };
    });
  } catch {
    rows = [];
  }

  return c.json({ transactions: rows });
});

export function getVccPool(): { number: string; exp: string; cvv: string; name: string }[] {
  return [];
}

export async function getVccPoolFromDb(): Promise<{ number: string; exp: string; cvv: string; name: string }[]> {
  const activeCards = db.vccCards.getAvailable();

  const cards = activeCards.map((card) => ({
    number: card.number,
    exp: `${card.expMonth}/${card.expYear.slice(-2)}`,
    cvv: card.cvv,
    name: card.name || "John Doe",
  }));

  // Shuffle to avoid race conditions in concurrent processes
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j]!, cards[i]!];
  }

  return cards;
}

export async function reserveCardForAccount(accountId: number): Promise<{ number: string; exp: string; cvv: string; name: string } | null> {
  const activeCards = db.vccCards.getAvailable();
  if (activeCards.length === 0) return null;
  const card = activeCards[0]!;

  call.upsertVccCard({
    id: card.id,
    number: card.number,
    expMonth: card.expMonth,
    expYear: card.expYear,
    cvv: card.cvv,
    name: card.name,
    status: "reserved",
    usedByAccountId: BigInt(accountId),
  });

  return {
    number: card.number,
    exp: `${card.expMonth}/${card.expYear.slice(-2)}`,
    cvv: card.cvv,
    name: card.name || "John Doe",
  };
}

export async function releaseReservedCard(accountId: number): Promise<void> {
  const allCards = db.vccCards.getAll();
  const reserved = allCards.filter((c) => c.usedByAccountId === BigInt(accountId));
  for (const card of reserved) {
    call.upsertVccCard({
      id: card.id,
      number: card.number,
      expMonth: card.expMonth,
      expYear: card.expYear,
      cvv: card.cvv,
      name: card.name,
      status: "active",
      usedByAccountId: null,
    });
  }
}

export async function handleCardResult(
  accountId: number,
  cardLast4: string,
  status: "success" | "declined" | "error"
): Promise<void> {
  const allCards = db.vccCards.getAll();
  const match = allCards.find((c) => c.number.endsWith(cardLast4));
  if (match) {
    if (status === "declined") {
      call.deleteVccCard({ id: match.id });
    } else {
      const newStatus = status === "success" ? "used" : match.status;
      call.upsertVccCard({
        id: match.id,
        number: match.number,
        expMonth: match.expMonth,
        expYear: match.expYear,
        cvv: match.cvv,
        name: match.name,
        status: newStatus,
        usedByAccountId: BigInt(accountId),
      });
    }
  }

  // Detect brand from card number for transaction record
  let cardBrand: string | null = null;
  if (match) {
    const num = match.number.replace(/\D/g, "");
    if (num.startsWith("4")) cardBrand = "visa";
    else if (/^5[1-5]/.test(num) || /^2[2-7]/.test(num)) cardBrand = "mastercard";
    else if (/^3[47]/.test(num)) cardBrand = "amex";
    else if (/^6(?:011|5|22126|4[4-9])/.test(num)) cardBrand = "discover";
  }

  call.insertVccTransaction({
    accountId: BigInt(accountId),
    cardLast4,
    cardBrand,
    amount: 0,
    currency: "usd",
    status,
    stripeChargeId: null,
  });
}

export { vccRouter };
