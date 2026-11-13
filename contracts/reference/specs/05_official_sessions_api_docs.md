# Sessions API Documentation

## Overview
The Sessions API provides endpoints for managing trading room sessions, including user management, statistics, and logs retrieval. All endpoints require API key authentication and are rate-limited to 1 request per second per command.

**Base URL:** `https://ptrv3.protradingroom.com/stats/v1`

## Authentication
All API requests require the following query parameters:
- `apiKey`: Your API key identifier
- `apiSecret`: Your API secret for authentication

## Rate Limiting
- **Limit:** 1 request per second per command
- **Response:** 429 status code with error message if exceeded

## Endpoints

### 1. Delete Users from Session
**POST** `/sessions/delUsers`

Removes users from a session and unsubscribes them from FCM alerts.

#### Request Parameters
**Query Parameters:**
- `apiKey` (required): Your API key
- `apiSecret` (required): Your API secret  
- `sessionID` (required): The session ID to remove users from

**Request Body:**
```json
{
  "delUsers": ["email1@gmail.com", "email2@gmail.com"]
}
```

#### Example Request
```bash
curl --location 'https://ptrv3.protradingroom.com/stats/v1/sessions/delUsers?apiKey=xxxxyyyyzzzz&apiSecret=xxxxyyyyzzzz&sessionID=111222333444' \
--header 'Content-Type: application/json' \
--data-raw '{"delUsers": ["email1@gmail.com","email2@gmail.com"]}'
```

#### Response
```json
{
  "success": true,
  "deletedUsers": ["email1@gmail.com", "email2@gmail.com"]
}
```

#### Error Responses
- `403`: Invalid API credentials or disabled API
- `429`: Rate limit exceeded
- `400`: No users provided for deletion
- `400`: Invalid session

---

### 2. Add Users to Session
**POST** `/sessions/addUsers`

Adds new users to a session or updates existing users' activity timestamps.

#### Request Parameters
**Query Parameters:**
- `apiKey` (required): Your API key
- `apiSecret` (required): Your API secret
- `sessionID` (required): The session ID to add users to

**Request Body:**
```json
{
  "users": [
    {
      "email": "user1@gmail.com",
      "name": "User One"
    },
    {
      "email": "user2@gmail.com", 
      "name": "User Two"
    }
  ]
}
```

#### Example Request
```bash
curl --location 'https://ptrv3.protradingroom.com/stats/v1/sessions/addUsers?apiKey=xxxxyyyyzzzz&apiSecret=xxxxyyyyzzzz&sessionID=111222333444' \
--header 'Content-Type: application/json' \
--data-raw '{"users": [{"email": "user1@gmail.com", "name": "User One"}]}'
```

#### Response
```json
{
  "success": true,
  "added": 1,
  "freshen": 0
}
```

#### Error Responses
- `403`: Invalid API credentials or disabled API
- `429`: Rate limit exceeded
- `400`: Invalid session

---

### 3. List Sessions
**GET** `/sessions/list`

Retrieves a list of all sessions owned by the API user.

#### Request Parameters
**Query Parameters:**
- `apiKey` (required): Your API key
- `apiSecret` (required): Your API secret

#### Example Request
```bash
curl --location 'https://ptrv3.protradingroom.com/stats/v1/sessions/list?apiKey=xxxxyyyyzzzz&apiSecret=xxxxyyyyzzzz'
```

#### Response
```json
{
  "success": true,
  "sessions": [
    {
      "_id": "111222333444",
      "uuid": "session-uuid",
      "name": "Trading Room 1",
      "currentState": "active",
      "current_capacity": 25,
      "current_max": 100,
      "modCount": 3,
      "recordedMaxCapacity": 150,
      "created": "2023-01-01T00:00:00.000Z",
      "updated": "2023-01-01T12:00:00.000Z",
      "s3Bucket": "bucket-name",
      "s3BucketFolderPath": "/path/to/folder",
      "isMainRoom": true,
      "recPreviewLocation": "/preview/location",
      "media": [
        {
          "mediaType": "video",
          "mediaValue": "stream-url"
        }
      ],
      "recording": false
    }
  ]
}
```

---

### 4. Get User Statistics
**GET** `/sessions/userstats`

Retrieves user statistics for a specific session within a date range.

#### Request Parameters
**Query Parameters:**
- `apiKey` (required): Your API key
- `apiSecret` (required): Your API secret
- `sessionID` (required): The session ID
- `fromDate` (optional): Start date for filtering (ISO format)
- `toDate` (optional): End date for filtering (ISO format)
- `isMobile` (optional): Filter for mobile users only

#### Example Request
```bash
curl --location 'https://ptrv3.protradingroom.com/stats/v1/sessions/userstats?apiKey=xxxxyyyyzzzz&apiSecret=xxxxyyyyzzzz&sessionID=111222333444&fromDate=2023-01-01&toDate=2023-01-31'
```

#### Response
```json
{
  "success": true,
  "userstats": [
    {
      "email": "user@example.com",
      "userName": "username",
      "uuid": "user-uuid",
      "ip": "192.168.1.1",
      "inTime": "2023-01-01T10:00:00.000Z",
      "outTime": "2023-01-01T12:00:00.000Z",
      "duration": 7200000,
      "isMobile": false
    }
  ]
}
```

---

### 5. Get Session Users
**GET** `/sessions/users`

Retrieves all users for a specific session with their activity status.

#### Request Parameters
**Query Parameters:**
- `apiKey` (required): Your API key
- `apiSecret` (required): Your API secret
- `sessionID` (required): The session ID

#### Example Request
```bash
curl --location 'https://ptrv3.protradingroom.com/stats/v1/sessions/users?apiKey=xxxxyyyyzzzz&apiSecret=xxxxyyyyzzzz&sessionID=111222333444'
```

#### Response
```json
{
  "success": true,
  "users": [
    {
      "_id": "user-id",
      "email": "user@example.com",
      "userName": "username",
      "role": 2,
      "lastLogin": "2023-01-01T10:00:00.000Z",
      "name": "User Name",
      "created": "2023-01-01T00:00:00.000Z",
      "updated": "2023-01-01T12:00:00.000Z",
      "alerterAppFCMUserOff": false,
      "alerterAppTokens": ["fcm-token-1", "fcm-token-2"],
      "activeDateAPI": "2023-01-01T12:00:00.000Z",
      "active": true
    }
  ]
}
```

---

### 6. Get Chat Logs
**GET** `/sessions/chatlogs`

Retrieves chat logs for a specific session and channel.

#### Request Parameters
**Query Parameters:**
- `apiKey` (required): Your API key
- `apiSecret` (required): Your API secret
- `sessionID` (required): The session ID
- `channel` (optional): Chat channel name (default: "main")
- `fromDate` (optional): Start date for filtering (ISO format)
- `toDate` (optional): End date for filtering (ISO format)

#### Example Request
```bash
curl --location 'https://ptrv3.protradingroom.com/stats/v1/sessions/chatlogs?apiKey=xxxxyyyyzzzz&apiSecret=xxxxyyyyzzzz&sessionID=111222333444&channel=main&fromDate=2023-01-01&toDate=2023-01-31'
```

#### Response
```json
{
  "success": true,
  "chatlogs": [
    {
      "sessionID": "111222333444",
      "c": "main",
      "t": "2023-01-01T10:00:00.000Z",
      "u": "user@example.com",
      "m": "Hello world!"
    }
  ]
}
```

---

### 7. Get Alert Logs
**GET** `/sessions/alertlogs`

Retrieves alert logs for a specific session.

#### Request Parameters
**Query Parameters:**
- `apiKey` (required): Your API key
- `apiSecret` (required): Your API secret
- `sessionID` (required): The session ID
- `fromDate` (optional): Start date for filtering (ISO format)
- `toDate` (optional): End date for filtering (ISO format)

#### Example Request
```bash
curl --location 'https://ptrv3.protradingroom.com/stats/v1/sessions/alertlogs?apiKey=xxxxyyyyzzzz&apiSecret=xxxxyyyyzzzz&sessionID=111222333444&fromDate=2023-01-01&toDate=2023-01-31'
```

#### Response
```json
{
  "success": true,
  "chatlogs": [
    {
      "sessionID": "111222333444",
      "t": "2023-01-01T10:00:00.000Z",
      "alertType": "price",
      "message": "Price alert triggered"
    }
  ]
}
```

---

### 8. Get Deleted Logs
**GET** `/sessions/deletedlogs`

Retrieves deleted message logs for a specific session.

#### Request Parameters
**Query Parameters:**
- `apiKey` (required): Your API key
- `apiSecret` (required): Your API secret
- `sessionID` (required): The session ID
- `logType` (optional): Type of log ("alerts" or "chat")
- `eventType` (optional): Event type ("E" for edit, "D" for delete)
- `fromDate` (optional): Start date for filtering (ISO format)
- `toDate` (optional): End date for filtering (ISO format)

#### Example Request
```bash
curl --location 'https://ptrv3.protradingroom.com/stats/v1/sessions/deletedlogs?apiKey=xxxxyyyyzzzz&apiSecret=xxxxyyyyzzzz&sessionID=111222333444&logType=chat&eventType=D'
```

#### Response
```json
{
  "success": true,
  "deletedlogs": [
    {
      "sessionID": "111222333444",
      "logType": "chat",
      "eventType": "D",
      "time": "2023-01-01T10:00:00.000Z",
      "originalMessage": "Deleted message content"
    }
  ]
}
```

---

### 9. Get Archived Logs
**GET** `/sessions/archivedlogs`

Retrieves archived logs for a specific session.

#### Request Parameters
**Query Parameters:**
- `apiKey` (required): Your API key
- `apiSecret` (required): Your API secret
- `sessionID` (required): The session ID
- `logType` (optional): Type of log ("alerts" or "chat", default: "chat")
- `channel` (optional): Chat channel name (default: "main")
- `fromDate` (optional): Start date for filtering (ISO format)
- `toDate` (optional): End date for filtering (ISO format)

#### Example Request
```bash
curl --location 'https://ptrv3.protradingroom.com/stats/v1/sessions/archivedlogs?apiKey=xxxxyyyyzzzz&apiSecret=xxxxyyyyzzzz&sessionID=111222333444&logType=chat&channel=main'
```

#### Response
```json
{
  "success": true,
  "archivedlogs": [
    {
      "sessionID": "111222333444",
      "logType": "chat",
      "channel": "main",
      "updated": "2023-01-01T10:00:00.000Z",
      "content": "Archived message content"
    }
  ]
}
```

---

### 10. Get Session Recordings
**GET** `/sessions/recordings`

Retrieves recording files for a specific session from the last 3 weeks.

#### Request Parameters
**Query Parameters:**
- `apiKey` (required): Your API key
- `apiSecret` (required): Your API secret
- `sessionID` (required): The session ID

#### Example Request
```bash
curl --location 'https://ptrv3.protradingroom.com/stats/v1/sessions/recordings?apiKey=xxxxyyyyzzzz&apiSecret=xxxxyyyyzzzz&sessionID=111222333444'
```

#### Response
```json
{
  "success": true,
  "recordings": [
    {
      "_id": "recording-id",
      "sessionID": "111222333444",
      "name": "recording-name.mp4",
      "namemkv": "recording-name.mkv",
      "contentType": "mp4",
      "created": "2023-01-01T10:00:00.000Z",
      "duration": 120,
      "length": 7200000,
      "fpath": "/path/to/recording",
      "media_server": "media.server.com",
      "vidPath": "https://media.server.com/path/to/recording",
      "ms": "media.server.com",
      "isUpload": false
    }
  ]
}
```

#### Response Fields
- `recordings`: Array of recording objects
  - `_id`: Unique recording identifier
  - `sessionID`: The session ID this recording belongs to
  - `name`: Recording filename with extension
  - `namemkv`: Original MKV filename (for MP4 recordings)
  - `contentType`: File format (mp4, webm, etc.)
  - `created`: Recording creation timestamp
  - `duration`: Duration in minutes
  - `length`: Duration in milliseconds
  - `fpath`: File path on media server
  - `media_server`: Media server hostname
  - `vidPath`: Full HTTPS URL to the recording
  - `ms`: Media server identifier
  - `isUpload`: Boolean indicating if this is an uploaded file

#### Notes
- Only returns recordings from the last 3 weeks
- Results are sorted by creation date (newest first)
- Returns empty array if no recordings found
- Upload files have duration set to 0
- Video files include both original MKV and processed format names

#### Error Responses
- `403`: Invalid API credentials or disabled API
- `429`: Rate limit exceeded
- `400`: Invalid session

---

### 11. Clone Session
**GET** `/sessions/cloneSession`

Creates a copy of an existing session. The clone inherits all settings from the source session, is assigned a new unique UUID, and has all presenter-role user cross-references duplicated. The API key must own the source session.

#### Request Parameters
**Query Parameters:**
- `apiKey` (required): Your API key
- `apiSecret` (required): Your API secret
- `sessionID` (required): The ID of the session to clone
- `name` (required): The name to assign to the new cloned session

#### Example Request
```bash
curl --location 'https://protradingroom.com/stats/v1/sessions/cloneSession?apiKey=xxxxyyyyzzzz&apiSecret=xxxxyyyyzzzz&sessionID=111222333444&name=My+Cloned+Room'
```

#### Response
```json
{
  "success": true,
  "session": {
    "_id": "555666777888",
    "uuid": 42,
    "name": "My Cloned Room",
    "isClonedRoom": true,
    "clonedFrom": "111222333444",
    "ownerdID": "owner-user-id",
    "currentState": "inactive",
    "created": "2023-06-01T10:00:00.000Z",
    "updated": "2023-06-01T10:00:00.000Z"
  }
}
```

#### Response Fields
- `session`: The newly created session object
  - `_id`: Unique identifier for the new session
  - `uuid`: Auto-incremented numeric room identifier
  - `name`: The name provided in the request
  - `isClonedRoom`: Always `true` for cloned sessions
  - `clonedFrom`: The `_id` of the source session
  - All other fields are inherited from the source session

#### Error Responses
- `403`: Invalid API credentials, disabled API, or session not allowed for this API key
- `429`: Rate limit exceeded
- `400`: Invalid session (not found or not owned by this API key)

## Error Codes

| Status Code | Description |
|-------------|-------------|
| 200 | Success |
| 400 | Bad Request - Invalid parameters or session |
| 403 | Forbidden - Invalid API credentials or disabled API |
| 429 | Too Many Requests - Rate limit exceeded |
| 500 | Internal Server Error |

## Notes

- All email addresses are automatically converted to lowercase
- Date parameters should be in ISO format (YYYY-MM-DD or full ISO timestamp)
- The `active` field in user responses indicates if the user was active in the last 24 hours
- FCM (Firebase Cloud Messaging) tokens are automatically managed for push notifications
- Bulk operations are used for adding users to improve performance
- Session validation ensures users can only access their own sessions
