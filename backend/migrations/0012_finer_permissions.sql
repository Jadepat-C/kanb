-- Finer, grouped board permissions. Every existing role keeps exactly what it could do before:
--   board.manage   -> + statuses.manage, notifications.manage (new)
--   board.delete   -> + board.archive (archive/restore used to need board.delete)
--   members.manage -> + roles.manage
--   lists.manage   -> lists.create, lists.edit, lists.archive, lists.delete
--   cards.edit     -> + cards.status, cards.due, cards.assign, cards.labels
--   cards.delete   -> + cards.archive (archive/restore used to need cards.delete)
--   cards.create   -> + templates.manage (managing templates used to need cards.create)
UPDATE board_roles SET permissions = ARRAY(
    SELECT DISTINCT p FROM unnest(
        array_remove(permissions, 'lists.manage')
        || CASE WHEN 'board.manage'   = ANY(permissions) THEN ARRAY['statuses.manage', 'notifications.manage'] ELSE '{}' END
        || CASE WHEN 'board.delete'   = ANY(permissions) THEN ARRAY['board.archive'] ELSE '{}' END
        || CASE WHEN 'members.manage' = ANY(permissions) THEN ARRAY['roles.manage'] ELSE '{}' END
        || CASE WHEN 'lists.manage'   = ANY(permissions) THEN ARRAY['lists.create', 'lists.edit', 'lists.archive', 'lists.delete'] ELSE '{}' END
        || CASE WHEN 'cards.edit'     = ANY(permissions) THEN ARRAY['cards.status', 'cards.due', 'cards.assign', 'cards.labels'] ELSE '{}' END
        || CASE WHEN 'cards.delete'   = ANY(permissions) THEN ARRAY['cards.archive'] ELSE '{}' END
        || CASE WHEN 'cards.create'   = ANY(permissions) THEN ARRAY['templates.manage'] ELSE '{}' END
    ) AS p ORDER BY p
);
