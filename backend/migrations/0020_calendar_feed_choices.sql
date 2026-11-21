-- What a user's calendar feed contains: the entire app, or only chosen boards and picked cards.
ALTER TABLE users ADD COLUMN calendar_all boolean NOT NULL DEFAULT true;         -- entire app (all my boards)
ALTER TABLE users ADD COLUMN calendar_only_mine boolean NOT NULL DEFAULT true;   -- board/app level: only cards assigned to me

CREATE TABLE calendar_feed_boards (
    user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, board_id)
);
CREATE TABLE calendar_feed_cards (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    card_id uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, card_id)
);
