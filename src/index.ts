import * as dotenv from 'dotenv';
import inquirer from 'inquirer';
import ky from 'ky';
import {
  initDatabase,
  saveProject,
  saveMergeRequest,
  getMergeRequestStats,
  getMergeRequest,
  countMrsWithLateFirstComment,
  MergeRequestData
} from './database';

dotenv.config();

const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
const GROUP_NAME = 'murid';
const GITLAB_API_URL = 'https://gitlab.com/api/v4';

if (!GITLAB_TOKEN) {
  console.error('GITLAB_TOKEN is not set in .env');
  process.exit(1);
}

// Create a reusable ky instance with pre-configured headers
const api = ky.extend({
  headers: {
    'PRIVATE-TOKEN': GITLAB_TOKEN
  },
  timeout: 30000,
  retry: 2
});

async function getGroupId(groupName: string): Promise<number | null> {
  try {
    const groups = await api.get(`${GITLAB_API_URL}/groups`, {
      searchParams: { search: groupName }
    }).json<any[]>();

    const group = groups.find((g) => g.name === groupName || g.path === groupName);
    return group ? group.id : null;
  } catch (err) {
    console.error('Failed to fetch group:', err);
    return null;
  }
}

async function listRepositories(groupId: number) {
  try {
    const projects = await api.get(`${GITLAB_API_URL}/groups/${groupId}/projects`).json<any[]>();
    return projects;
  } catch (err) {
    console.error('Failed to fetch repositories:', err);
    return [];
  }
}

// Function to fetch all merge requests for a specific project (with pagination)
async function fetchMergeRequests(projectId: number) {
  try {
    let allMergeRequests: any[] = [];
    let page = 1;
    let hasMorePages = true;

    console.log('Fetching merge requests (paginated)...');

    while (hasMorePages) {
      console.log(`Fetching page ${page}...`);

      // Explicitly convert parameters to strings to ensure they're properly encoded
      const response = await api.get(`${GITLAB_API_URL}/projects/${projectId}/merge_requests`, {
        searchParams: {
          state: 'all',
          per_page: '100', // Convert to string
          page: page.toString() // Convert page to string
        },
        timeout: false // Disable timeout for larger responses
      });

      // Check if we have data
      const mergeRequests = await response.json<any[]>();
      console.log(`Retrieved ${mergeRequests.length} MRs from page ${page}`);

      if (mergeRequests.length === 0) {
        // No more data, stop pagination
        hasMorePages = false;
      } else {
        allMergeRequests = [...allMergeRequests, ...mergeRequests];

        // Check if there are more pages using GitLab's pagination headers
        const totalPages = Number(response.headers.get('x-total-pages') || '0');
        const currentPage = Number(response.headers.get('x-page') || '0');
        const totalItems = Number(response.headers.get('x-total') || '0');

        console.log(`Page info: ${currentPage} of ${totalPages} (Total items: ${totalItems})`);

        // Use both header info and array length to determine if there are more pages
        hasMorePages = (totalPages > 0 && page < totalPages) ||
                       (mergeRequests.length === 100); // If we got 100 items, there might be more

        page++;
      }
    }

    console.log(`Total MRs fetched: ${allMergeRequests.length}`);
    return allMergeRequests;
  } catch (err) {
    console.error('Failed to fetch merge requests:', err);
    return [];
  }
}

// Function to fetch MR details including comments and approvals (with pagination for notes)
async function fetchMergeRequestDetails(projectId: number, mrIid: number): Promise<any> {
  try {
    // Fetch notes (comments) with pagination
    let allNotes: any[] = [];
    let page = 1;
    let hasMorePages = true;

    while (hasMorePages) {
      console.log(`  Fetching notes page ${page} for MR #${mrIid}...`);
      const response = await api.get(`${GITLAB_API_URL}/projects/${projectId}/merge_requests/${mrIid}/notes`, {
        searchParams: {
          per_page: 100,
          page
        }
      });

      // GitLab returns pagination info in headers
      const totalPages = Number(response.headers.get('x-total-pages')) || 1;

      const notes = await response.json<any[]>();
      allNotes = [...allNotes, ...notes];

      // Check if we've reached the last page
      hasMorePages = page < totalPages;
      page++;

      if (notes.length > 0) {
        console.log(`  Retrieved ${notes.length} notes from page ${page-1}`);
      }
    }

    // Instead of using the /approvals endpoint, fetch the approval events
    // This endpoint gives us the actual approval timestamps
    const approvalEvents = await api.get(
      `${GITLAB_API_URL}/projects/${projectId}/merge_requests/${mrIid}/resource_approval_events`
    ).json<any[]>().catch(() => []);

    return { notes: allNotes, approvalEvents };
  } catch (err) {
    console.error(`Failed to fetch details for MR ${mrIid}:`, err);
    return { notes: [], approvalEvents: [] };
  }
}

// Function to process and store merge requests with their details
async function processAndStoreMergeRequests(projectId: number, project: any) {
  console.log('Fetching merge requests...');
  const mergeRequests = await fetchMergeRequests(projectId);

  if (mergeRequests.length === 0) {
    console.log('No merge requests found.');
    return;
  }

  console.log(`Found ${mergeRequests.length} merge requests. Processing...`);
  await saveProject(project);

  // Track statistics
  let skippedCount = 0;
  let updatedCount = 0;
  let newCount = 0;

  for (const mr of mergeRequests) {
    // Check if the MR already exists in the database
    const existingMR = await getMergeRequest(projectId, mr.id);

    // Skip MRs that are already merged and in the database (no need to process again)
    if (existingMR && mr.state === 'merged' && existingMR.state === 'merged') {
      console.log(`Skipping MR #${mr.iid}: "${mr.title}" - already processed and merged.`);
      skippedCount++;
      continue;
    }

    // Check if update is needed (MR exists but details might have changed)
    const needsUpdate = existingMR && (
      existingMR.updated_at !== mr.updated_at ||
      existingMR.state !== mr.state
    );

    // If no update needed, skip this MR
    if (existingMR && !needsUpdate) {
      console.log(`Skipping MR #${mr.iid}: "${mr.title}" - no changes detected.`);
      skippedCount++;
      continue;
    }

    // Log what we're doing
    if (existingMR) {
      console.log(`Updating MR #${mr.iid}: "${mr.title}"`);
      updatedCount++;
    } else {
      console.log(`Processing new MR #${mr.iid}: "${mr.title}"`);
      newCount++;
    }

    // Fetch details for new or changed MRs
    const details = await fetchMergeRequestDetails(projectId, mr.iid);

    // Find first comment time
    let firstComment = null;
    if (details.notes && details.notes.length > 0) {
      // Filter out system notes and sort by creation time
      const userNotes = details.notes.filter((note: any) => !note.system);
      if (userNotes.length > 0) {
        userNotes.sort((a: any, b: any) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        );
        firstComment = userNotes[0].created_at;
      }
    }

    // Extract approval time if available
    let approvedAt = null;
    if (details.approvalEvents && details.approvalEvents.length > 0) {
      // Get the timestamp of the first approval event (earliest approval)
      const sortedEvents = [...details.approvalEvents].sort((a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
      approvedAt = sortedEvents[0].created_at;
      console.log(`  Found approval timestamp: ${approvedAt} for MR #${mr.iid}`);
    } else {
      console.log(`  No approval events found for MR #${mr.iid}`);
    }

    // Save the merge request data
    const mrData: MergeRequestData = {
      id: mr.id,
      project_id: projectId,
      title: mr.title,
      created_at: mr.created_at,
      updated_at: mr.updated_at,
      state: mr.state,
      author_id: mr.author.id,
      author_username: mr.author.username,
      first_comment_at: firstComment,
      approved_at: approvedAt,
      merged_at: mr.merged_at
    };

    await saveMergeRequest(mrData);
  }

  console.log('All merge requests processed.');
  console.log(`Summary: ${newCount} new, ${updatedCount} updated, ${skippedCount} skipped.`);
}

// Helper function to format time in minutes to a readable format
function formatTime(minutes: number | null): string {
  if (minutes === null || isNaN(minutes)) return 'N/A';

  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes % (60 * 24)) / 60);
  const mins = Math.floor(minutes % 60);

  if (days > 0) {
    return `${days}d ${hours}h ${mins}m`;
  } else if (hours > 0) {
    return `${hours}h ${mins}m`;
  } else {
    return `${mins}m`;
  }
}

// Function to display MR statistics with date range filtering
async function displayMergeRequestStats(projectId: number, startDate?: string, endDate?: string, commentThreshold?: number) {
  const stats = await getMergeRequestStats(projectId, startDate, endDate);

  let lateCommentCount = 0;
  if (commentThreshold !== undefined) {
    // Get count of MRs with late first comments
    lateCommentCount = await countMrsWithLateFirstComment(projectId, commentThreshold, startDate, endDate);
  }

  const dateRangeText = startDate && endDate
    ? `from ${startDate} to ${endDate}`
    : startDate
    ? `after ${startDate}`
    : endDate
    ? `before ${endDate}`
    : 'all time';

  console.log(`\n----- Merge Request Statistics (${dateRangeText}) -----`);
  console.log(`Total MRs: ${stats.totalMRs}`);
  console.log(`Merged MRs: ${stats.mergedMRs} (${stats.totalMRs > 0 ? Math.round(stats.mergedMRs / stats.totalMRs * 100) : 0}%)`);
  console.log(`Average time to first comment: ${formatTime(stats.avgTimeToFirstComment)}`);
  console.log(`Average time to approval: ${formatTime(stats.avgTimeToApproval)}`);
  console.log(`Average time to merge: ${formatTime(stats.avgTimeToMerge)}`);

  // Display late comment statistics if threshold was provided
  if (commentThreshold !== undefined) {
    const percentage = stats.totalMRs > 0
      ? Math.round((lateCommentCount / stats.totalMRs) * 100)
      : 0;
    console.log(`\nMRs with first comment after ${formatTime(commentThreshold)}: ${lateCommentCount} (${percentage}%)`);
  }

  console.log('------------------------------------');
}

// Helper to validate date format (YYYY-MM-DD)
function isValidDate(dateStr: string): boolean {
  if (!dateStr) return true; // Empty is valid (no filter)

  // Check format
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(dateStr)) return false;

  // Check if it's a valid date
  const date = new Date(dateStr);
  return date instanceof Date && !isNaN(date.getTime());
}

async function main() {
  // Initialize the database
  await initDatabase();

  const groupId = await getGroupId(GROUP_NAME);
  if (!groupId) {
    console.error(`Group '${GROUP_NAME}' not found.`);
    process.exit(1);
  }

  const repos = await listRepositories(groupId);
  if (repos.length === 0) {
    console.log('No repositories found in this group.');
    return;
  }

  const choices = repos.map((repo: any) => ({ name: repo.name_with_namespace, value: repo.id, repo }));

  const { actionType } = await inquirer.prompt([
    {
      type: 'list',
      name: 'actionType',
      message: 'What would you like to do?',
      choices: [
        { name: 'Fetch MRs for a repository', value: 'fetch' },
        { name: 'View MR statistics for a repository', value: 'stats' }
      ]
    }
  ]);

  const { selectedRepo } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selectedRepo',
      message: 'Select a repository:',
      choices
    }
  ]);

  const selectedChoice = choices.find((c: any) => c.value === selectedRepo);
  if (!selectedChoice) {
    console.error('Selected repository not found in choices.');
    process.exit(1);
  }
  const selectedProject = selectedChoice.repo;

  if (actionType === 'fetch') {
    await processAndStoreMergeRequests(selectedRepo, selectedProject);
  } else if (actionType === 'stats') {
    // Prompt for date range filtering
    const { useDateFilter } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'useDateFilter',
        message: 'Do you want to filter by date range?',
        default: false
      }
    ]);

    let startDate, endDate;

    if (useDateFilter) {
      const dateResponses = await inquirer.prompt([
        {
          type: 'input',
          name: 'startDate',
          message: 'Enter start date (YYYY-MM-DD) or leave empty:',
          validate: isValidDate
        },
        {
          type: 'input',
          name: 'endDate',
          message: 'Enter end date (YYYY-MM-DD) or leave empty:',
          validate: isValidDate
        }
      ]);

      startDate = dateResponses.startDate || undefined;
      endDate = dateResponses.endDate || undefined;
    }

    // Prompt for comment threshold
    const { commentThreshold } = await inquirer.prompt([
      {
        type: 'input',
        name: 'commentThreshold',
        message: 'Enter comment threshold in minutes (or leave empty for no filter):',
        default: '',
        validate: (input) => {
          if (input === '') return true; // Empty is valid
          const num = Number(input);
          return !isNaN(num) && num >= 0;
        }
      }
    ]);

    await displayMergeRequestStats(selectedRepo, startDate, endDate, commentThreshold !== '' ? Number(commentThreshold) : undefined);
  }
}

main();
