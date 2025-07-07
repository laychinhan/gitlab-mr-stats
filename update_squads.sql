-- Update merge_requests table to set squad values based on author_username

-- First, set squad to 'CMS' for the specified usernames
UPDATE merge_requests
SET squad = 'CMS'
WHERE author_username IN ('miduddin.wartek', 'alvin.yaputra', 'qoyyim', 'sangbas-wartek', 'burhan-wartek');

-- Then, set squad to 'WEB' for all usernames that are not in the CMS list and not 'ikhsan.hari'
UPDATE merge_requests
SET squad = 'WEB'
WHERE author_username NOT IN ('miduddin.wartek', 'alvin.yaputra', 'qoyyim', 'sangbas-wartek', 'burhan-wartek', 'ikhsan.hari')
AND squad IS NULL;  -- Only update records that don't have a squad value already

-- Verify the results
SELECT author_username, squad, COUNT(*) as count
FROM merge_requests
GROUP BY author_username, squad
ORDER BY squad, author_username;
