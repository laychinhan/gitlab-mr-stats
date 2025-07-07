// Use CommonJS style import for sqlite3
import * as sqlite3 from 'sqlite3';
import { promisify } from 'util';

// Define the MR data type
export interface MergeRequestData {
  id: number;
  project_id: number;
  title: string;
  description?: string;
  created_at: string;
  updated_at: string;
  state: string;
  author_id: number;
  author_username: string;
  first_comment_at?: string;
  approved_at?: string;
  merged_at?: string;
  squad?: string;
}

// Create a promisified database class
class Database {
  private db: sqlite3.Database;

  constructor(filename: string) {
    this.db = new sqlite3.Database(filename);
  }

  run(sql: string, params: any[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) {
          reject(err);
          return;
        }
        resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }

  get(sql: string, params: any[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(row);
      });
    });
  }

  all(sql: string, params: any[] = []): Promise<any[]> {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(rows);
      });
    });
  }

  exec(sql: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.exec(sql, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
}

let db: Database;

export async function initDatabase(): Promise<Database> {
  if (db) return db;

  // Create the database
  db = new Database('./gitlab_data.sqlite');

  // Create tables if they don't exist
  await db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      path_with_namespace TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS merge_requests (
      id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      state TEXT NOT NULL,
      author_id INTEGER NOT NULL,
      author_username TEXT NOT NULL,
      first_comment_at TEXT,
      approved_at TEXT,
      merged_at TEXT,
      PRIMARY KEY (id, project_id),
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );
  `);

  // Add new squad column to merge_requests table if it doesn't exist
  try {
    await db.exec(`ALTER TABLE merge_requests ADD COLUMN squad VARCHAR(30) NULL;`);
    console.log('Added squad column to merge_requests table');
  } catch (err) {
    // Column may already exist, which is fine
    // @ts-ignore
    console.log('Squad column might already exist:', err.message);
  }

  // Add description column to merge_requests table if it doesn't exist
  try {
    await db.exec(`ALTER TABLE merge_requests ADD COLUMN description TEXT NULL;`);
    console.log('Added description column to merge_requests table');
  } catch (err) {
    // Column may already exist, which is fine
    // @ts-ignore
    console.log('Description column might already exist:', err.message);
  }

  return db;
}

export async function saveProject(project: any): Promise<void> {
  await db.run(
    `INSERT OR REPLACE INTO projects (id, name, path_with_namespace, created_at) 
     VALUES (?, ?, ?, ?)`,
    [project.id, project.name, project.path_with_namespace, project.created_at]
  );
}

export async function saveMergeRequest(mr: MergeRequestData): Promise<void> {
  await db.run(
    `INSERT OR REPLACE INTO merge_requests 
     (id, project_id, title, created_at, updated_at, state, author_id, 
          author_username, first_comment_at, approved_at, merged_at, squad, description) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      mr.id, mr.project_id, mr.title, mr.created_at, mr.updated_at,
      mr.state, mr.author_id, mr.author_username, mr.first_comment_at,
      mr.approved_at, mr.merged_at, mr.squad, mr.description
    ]
  );
}

// Check if a merge request exists in the database
export async function getMergeRequest(projectId: number, mrId: number): Promise<MergeRequestData | null> {
  try {
    const mr = await db.get(
      `SELECT * FROM merge_requests WHERE project_id = ? AND id = ?`,
      [projectId, mrId]
    );
    return mr || null;
  } catch (err) {
    console.error('Failed to check merge request:', err);
    return null;
  }
}

export async function getMergeRequestStats(
  projectId: number,
  startDate?: string,
  endDate?: string
): Promise<{
  squad: string;
  avg_time_to_first_comment: number | null;
  avg_time_to_approval: number | null;
  avg_time_to_merge: number | null;
  total_mrs: number;
  merged_mrs: number;
}[]> {
  // Build WHERE clause with date filtering and exclude closed MRs and null squads
  let whereClause = 'project_id = ? AND state != "closed" AND squad IS NOT NULL';
  const params: any[] = [projectId];

  if (startDate) {
    whereClause += ' AND created_at >= ?';
    params.push(startDate);
  }

  if (endDate) {
    whereClause += ' AND created_at <= ?';
    params.push(endDate);
  }

  const stats = await db.all(`
    SELECT 
      squad,
      COUNT(*) as total_mrs,
      SUM(CASE WHEN state = 'merged' THEN 1 ELSE 0 END) as merged_mrs,
      AVG(CASE 
        WHEN first_comment_at IS NOT NULL 
        THEN (strftime('%s', first_comment_at) - strftime('%s', created_at)) / 60.0
        ELSE NULL 
      END) as avg_time_to_first_comment,
      
      AVG(CASE 
        WHEN approved_at IS NOT NULL 
        THEN (strftime('%s', approved_at) - strftime('%s', created_at)) / 60.0
        ELSE NULL 
      END) as avg_time_to_approval,
      
      AVG(CASE 
        WHEN merged_at IS NOT NULL 
        THEN (strftime('%s', merged_at) - strftime('%s', created_at)) / 60.0
        ELSE NULL 
      END) as avg_time_to_merge
      
    FROM merge_requests
    WHERE ${whereClause}
    GROUP BY squad
  `, params);

  return stats;
}

// Count MRs with first comment time exceeding threshold
export async function countMrsWithLateFirstComment(
  projectId: number,
  thresholdMinutes: number,
  startDate?: string,
  endDate?: string
): Promise<{ squad: string, count: number }[]> {
  // Build WHERE clause with date filtering and exclude closed MRs and null squads
  let whereClause = 'project_id = ? AND state != "closed" AND first_comment_at IS NOT NULL AND squad IS NOT NULL';
  const params: any[] = [projectId];

  if (startDate) {
    whereClause += ' AND created_at >= ?';
    params.push(startDate);
  }

  if (endDate) {
    whereClause += ' AND created_at <= ?';
    params.push(endDate);
  }

  // Add time difference comparison
  whereClause += ` AND (strftime('%s', first_comment_at) - strftime('%s', created_at)) / 60.0 > ?`;
  params.push(thresholdMinutes);

  const result = await db.all(`
    SELECT squad, COUNT(*) as count
    FROM merge_requests
    WHERE ${whereClause}
    GROUP BY squad
  `, params);

  return result;
}
