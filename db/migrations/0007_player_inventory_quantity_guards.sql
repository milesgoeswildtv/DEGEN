-- Keep D1 inventory quantities exact in the JavaScript number model.
-- Existing rows are intentionally not rewritten; runtime reads fail closed on legacy corruption.
CREATE TRIGGER IF NOT EXISTS player_inventory_quantity_insert_guard
BEFORE INSERT ON player_inventory
WHEN typeof(NEW.quantity) <> 'integer'
  OR NEW.quantity < 1
  OR NEW.quantity > 9007199254740991
BEGIN
  SELECT RAISE(ABORT, 'player_inventory.quantity must be a positive safe integer');
END;

CREATE TRIGGER IF NOT EXISTS player_inventory_quantity_update_guard
BEFORE UPDATE OF quantity ON player_inventory
WHEN typeof(NEW.quantity) <> 'integer'
  OR NEW.quantity < 1
  OR NEW.quantity > 9007199254740991
BEGIN
  SELECT RAISE(ABORT, 'player_inventory.quantity must be a positive safe integer');
END;
