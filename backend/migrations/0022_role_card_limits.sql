-- Two optional limits per role (the Owner role ignores both):
--   own_cards_only   the role's card permissions (edit, move, archive, delete, …) and attachment permissions
--                    apply only to cards the member created themselves
--   card_list_ids    columns the role may add cards to; NULL = any column. A column that's later deleted just drops
--                    out of the list, so the role can't add cards anywhere it no longer names.
-- Existing roles get neither limit, so nothing changes until a board owner sets one.
ALTER TABLE board_roles
    ADD COLUMN own_cards_only boolean NOT NULL DEFAULT false,
    ADD COLUMN card_list_ids uuid[];
