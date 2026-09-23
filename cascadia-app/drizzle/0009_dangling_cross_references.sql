-- Remove cross-design references that name an item which no longer exists.
--
-- design_cross_references.referenced_item_id carries no foreign key, so a hard
-- delete of the referenced item cascaded nothing and left the reference behind,
-- naming nothing. The structure of the referencing design resolves no node for
-- such a row and silently drops that root, there is then no node to remove it
-- from, and the list of references still returns it with no item. A hard delete
-- cannot be undone, so there is no item to repair the row towards: it is
-- residue. ItemService.delete now refuses while a live reference names the item
-- and removes the bookkeeping rows that do, so this clears only what earlier
-- deletes left behind.
--
-- No schema change, so db:baseline cannot tell whether this has run and leaves
-- it pending. It must therefore do nothing the second time, and it does: a
-- second run finds no row whose item is missing.
DELETE FROM "design_cross_references"
WHERE NOT EXISTS (
  SELECT 1
  FROM "items"
  WHERE "items"."id" = "design_cross_references"."referenced_item_id"
);
