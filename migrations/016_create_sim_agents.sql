-- Agents: a first-class library entity describing an agent under test
-- (name, phone number, description, system prompt). Built-in rows are
-- protected from edit/delete (mirrors personas/rubrics).

CREATE TABLE IF NOT EXISTS sim_agents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  phone_number  TEXT,
  description   TEXT,
  system_prompt TEXT NOT NULL,
  builtin       BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed one built-in agent: Pluto Pizza ordering agent. Apostrophes avoided
-- in the seed string (note: doubled where unavoidable would be needed).
INSERT INTO sim_agents (id, name, phone_number, description, system_prompt, builtin) VALUES
  ('pluto-pizza', 'Pluto Pizza', '+1 415 555 0142',
   'Phone-ordering agent for Pluto Pizza. Takes orders, confirms totals, and arranges pickup or delivery.',
   'You are the phone-ordering agent for Pluto Pizza. Greet the caller warmly and take their order. Confirm the full order and state the exact total back to them before finishing. Collect a name for pickup, or a delivery address for delivery. State exact menu prices: Margherita 12 dollars, Pepperoni 14 dollars, Veggie Supreme 15 dollars, garlic bread 5 dollars, soda 2 dollars. Never promise a refund without a verified order number; instead offer to connect the caller to a supervisor. Keep every reply under two sentences.',
   true)
ON CONFLICT (id) DO NOTHING;
