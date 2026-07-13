-- Link still-unmatched accounts to employees using a conservative Czech
-- diacritic-insensitive comparison. Updates happen only when the match is
-- unique for both the account and employee.
WITH candidate_matches AS (
  SELECT DISTINCT u.id AS user_id, p.id AS person_id
  FROM "users" u
  JOIN "people" p ON
    translate(lower(trim(p.name)), 'áčďéěíňóřšťúůýž', 'acdeeinorstuuyz') =
    translate(lower(trim(u.name)), 'áčďéěíňóřšťúůýž', 'acdeeinorstuuyz')
  WHERE u.person_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "users" linked WHERE linked.person_id = p.id
    )
), unique_user_matches AS (
  SELECT user_id, min(person_id) AS person_id
  FROM candidate_matches
  GROUP BY user_id
  HAVING count(DISTINCT person_id) = 1
), exclusive_matches AS (
  SELECT person_id, min(user_id) AS user_id
  FROM unique_user_matches
  GROUP BY person_id
  HAVING count(DISTINCT user_id) = 1
)
UPDATE "users" u
SET "person_id" = matches.person_id
FROM exclusive_matches matches
WHERE u.id = matches.user_id
  AND u.person_id IS NULL;
