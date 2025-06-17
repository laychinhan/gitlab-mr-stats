# Create gitlab token

1. Go to your GitLab account.
2. Navigate to User Settings > Access Tokens.
3. Create a new personal access token with the following scopes:
    - `api` (to access the GitLab API)
    - `read_user` (to read user information)
    - `read_repository` (to read repository information)
    - `read_api` (to read API data)
4. Copy the generated token and store it on the `.env` file.

# Install dependencies and Run the project

1. Open your terminal and navigate to the project directory.
2. Run the following command to install the dependencies:
   ```bash
   yarn install
   ```
3. Create a `.env` file in the root directory of the project and add your GitLab token:
   ```plaintext
    GITLAB_TOKEN=your_gitlab_token_here
   ```
4. Run the project using the following command:
   ```bash
   npx ts-node src/index.ts
   ```