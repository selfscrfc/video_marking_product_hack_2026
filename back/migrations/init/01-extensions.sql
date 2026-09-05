-- Нужно для ограничения segments_no_overlap: EXCLUDE USING gist по numrange
-- требует btree_gist, чтобы в том же индексе жило равенство по annotation_id.
CREATE EXTENSION IF NOT EXISTS btree_gist;
