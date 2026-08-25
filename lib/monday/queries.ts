/**
 * Monday.com GraphQL API v2 queries.
 *
 * Note on `column_values`: since API version 2023-10 the column title is no
 * longer a direct field on `column_values` — it lives on the nested `column`
 * object. Querying `title` directly returns a GraphQL error, so we always go
 * through `column { title }` and flatten it client-side.
 */

export const GET_BOARD_META = `
  query GetBoardMeta($boardId: ID!) {
    boards(ids: [$boardId]) {
      id
      name
      columns {
        id
        title
        type
      }
    }
  }
`;

export const GET_BOARD_ITEMS_PAGE = `
  query GetBoardItems($boardId: ID!, $limit: Int!, $cursor: String) {
    boards(ids: [$boardId]) {
      id
      name
      items_page(limit: $limit, cursor: $cursor) {
        cursor
        items {
          id
          name
          column_values {
            id
            type
            text
            value
            column {
              title
            }
          }
        }
      }
    }
  }
`;
