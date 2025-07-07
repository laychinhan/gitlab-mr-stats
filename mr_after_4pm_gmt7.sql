-- Query to find merge requests created after 4 PM in GMT+7 timezone
-- SQLite stores timestamps in UTC, so we need to add 7 hours to convert to GMT+7
-- Then extract the hour to check if it's >= 16 (4 PM)

SELECT
    id,
    project_id,
    title,
    created_at AS created_at_utc,
    -- Convert UTC time to GMT+7 by adding 7 hours (7*3600 seconds)
    datetime(created_at, '+7 hours') AS created_at_gmt7,
    -- Extract hour from the GMT+7 time
    strftime('%H', datetime(created_at, '+7 hours')) AS hour_gmt7,
    author_username,
    squad,
    first_comment_at,
    -- Calculate duration until first comment (in minutes)
    CASE
        WHEN first_comment_at IS NOT NULL
        THEN round((strftime('%s', first_comment_at) - strftime('%s', created_at)) / 60.0, 2)
        ELSE NULL
    END AS minutes_until_first_comment,
    -- Format duration in a more readable way (hh:mm:ss)
    CASE
        WHEN first_comment_at IS NOT NULL
        THEN
            (strftime('%s', first_comment_at) - strftime('%s', created_at)) / 3600 || 'h ' ||
            ((strftime('%s', first_comment_at) - strftime('%s', created_at)) % 3600) / 60 || 'm ' ||
            ((strftime('%s', first_comment_at) - strftime('%s', created_at)) % 60) || 's'
        ELSE 'No comment yet'
    END AS duration_until_first_comment
FROM
    merge_requests
WHERE
    -- Select MRs created at or after 4 PM (16:00) in GMT+7
    CAST(strftime('%H', datetime(created_at, '+7 hours')) AS INTEGER) >= 16
ORDER BY
    created_at_gmt7 DESC;

-- Alternative query with more detailed time information
SELECT
    id,
    project_id,
    title,
    created_at AS created_at_utc,
    datetime(created_at, '+7 hours') AS created_at_gmt7,
    -- Format time as HH:MM:SS for better readability
    strftime('%H:%M:%S', datetime(created_at, '+7 hours')) AS time_gmt7,
    author_username,
    squad,
    first_comment_at,
    -- Calculate duration until first comment (in minutes)
    CASE
        WHEN first_comment_at IS NOT NULL
        THEN round((strftime('%s', first_comment_at) - strftime('%s', created_at)) / 60.0, 2)
        ELSE NULL
    END AS minutes_until_first_comment,
    -- Format duration in a more readable way (hh:mm:ss)
    CASE
        WHEN first_comment_at IS NOT NULL
        THEN
            (strftime('%s', first_comment_at) - strftime('%s', created_at)) / 3600 || 'h ' ||
            ((strftime('%s', first_comment_at) - strftime('%s', created_at)) % 3600) / 60 || 'm ' ||
            ((strftime('%s', first_comment_at) - strftime('%s', created_at)) % 60) || 's'
        ELSE 'No comment yet'
    END AS duration_until_first_comment
FROM
    merge_requests
WHERE
    CAST(strftime('%H', datetime(created_at, '+7 hours')) AS INTEGER) >= 16
ORDER BY
    created_at_gmt7 DESC;

-- If you want to see the distribution of MRs by hour in GMT+7
SELECT
    strftime('%H', datetime(created_at, '+7 hours')) AS hour_gmt7,
    COUNT(*) AS mr_count,
    squad,
    AVG(CASE
        WHEN first_comment_at IS NOT NULL
        THEN (strftime('%s', first_comment_at) - strftime('%s', created_at)) / 60.0
        ELSE NULL
    END) AS avg_minutes_until_comment
FROM
    merge_requests
WHERE
    squad IS NOT NULL
GROUP BY
    hour_gmt7, squad
ORDER BY
    squad, hour_gmt7;
