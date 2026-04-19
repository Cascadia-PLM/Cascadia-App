# Issues: Administration

Issues discovered while researching and documenting the admin features (user management, access control, system settings, background jobs).

User list filtering issue has been resolved — `UserService.listUsers()` now uses
database-level filtering with dynamic Drizzle `where` conditions.
