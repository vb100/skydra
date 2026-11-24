-- 0014_adverse_media: adverse-media articles (Brave Search, GDELT) are stored as matches of the
-- ADVERSE_MEDIA category in the same check as sanctions and PEP, so the checklist, the colours
-- and the report treat them alike.
--
--   * A broker marks an article "about this person" (TRUE_POSITIVE), "about someone else"
--     (FALSE_POSITIVE) or "not relevant" (NOT_RELEVANT, new), always with a comment.
--   * A check records which sources it used (e.g. OPENSANCTIONS, BRAVE), so the FIU can see what
--     was searched where.

ALTER TABLE screening_matches DROP CONSTRAINT screening_matches_review_status_check;
ALTER TABLE screening_matches ADD CONSTRAINT screening_matches_review_status_check
  CHECK (review_status IN ('OPEN', 'FALSE_POSITIVE', 'TRUE_POSITIVE', 'NOT_RELEVANT'));

-- "Not relevant" is a decision about an article only.
ALTER TABLE screening_matches ADD CONSTRAINT screening_matches_not_relevant_article
  CHECK (review_status <> 'NOT_RELEVANT' OR 'ADVERSE_MEDIA' = ANY (categories));

ALTER TABLE screening_checks
  ADD COLUMN sources text[] NOT NULL DEFAULT '{}'
    CHECK (sources <@ ARRAY['MOCK', 'MANUAL', 'OPENSANCTIONS', 'BRAVE', 'GDELT']);
