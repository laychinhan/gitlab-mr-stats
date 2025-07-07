-- Query to fetch merge requests created after April 1st, 2025
SELECT
    id,
    description
FROM
    merge_requests
WHERE
    created_at >= '2025-04-01 00:00:00'
and squad = 'WEB'
ORDER BY
    created_at ASC;

