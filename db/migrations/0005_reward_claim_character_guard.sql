-- Track the most recent atomic character reward grant for cross-permit CAS.
-- No monster or combat resource state is introduced.
ALTER TABLE characters ADD COLUMN last_reward_claim_token TEXT;
