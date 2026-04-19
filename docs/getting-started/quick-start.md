# Quick Start

First steps after installing Cascadia PLM. This guide assumes you have completed the [Installation](./installation.md) and have the dev server running.

## Seed the database

If you haven't already, seed the database with the minimal data set:

```bash
npm run db:seed
```

This creates:

| Item                       | Details                                                             |
| -------------------------- | ------------------------------------------------------------------- |
| **Admin user**             | `admin@cascadia.local` / `Cascadia`                                 |
| **Roles**                  | Global Admin, Administrator, Power User, Approver, User, View Only  |
| **Default Program**        | Code: `DEFAULT`                                                     |
| **Standard Parts Library** | Code: `STD-LIB` (global, not tied to any program)                   |
| **Lifecycles**             | Part, Document (Driven by ECO), ChangeOrder (Driving), Issue (Free) |
| **Flexible Workflow**      | Dynamic Change Order (customizable per instance)                    |
| **Item Type Configs**      | Lifecycle assignments and role-based permissions                    |

### Component catalog (optional)

To load a generic starter catalog (fasteners, raw stock, categories) into the Standard Parts Library:

```bash
npm run db:seed:catalog
```

> **Tip**: If you get duplicate key errors when seeding, run `npm run db:reset:seed` first to truncate all tables and re-apply the minimal seed.

## Log in

Open **http://localhost:3000** and log in with the default admin credentials:

- **Email**: `admin@cascadia.local`
- **Password**: `Cascadia`

## UI layout overview

After login, you land on the **Dashboard**. The main navigation is in the left sidebar:

| Section               | Path                 | Description                                    |
| --------------------- | -------------------- | ---------------------------------------------- |
| **Dashboard**         | `/`                  | Overview stats, recent activity, charts        |
| **Parts**             | `/parts`             | Browse, create, and manage parts               |
| **Documents**         | `/documents`         | Document control and file management           |
| **Change Orders**     | `/change-orders`     | Engineering Change Orders (ECOs)               |
| **Requirements**      | `/requirements`      | Requirements management                        |
| **Issues**            | `/issues`            | Issue tracking                                 |
| **Tasks**             | `/tasks`             | Task management                                |
| **Work Instructions** | `/work-instructions` | Author and execute work instructions           |
| **Designs**           | `/designs`           | Design containers (version boundaries)         |
| **Programs**          | `/programs`          | Top-level organizational units                 |
| **Reports**           | `/reports`           | Analytics and reporting                        |
| **Lifecycles**        | `/lifecycles`        | View and manage lifecycle/workflow definitions |
| **Admin**             | `/admin`             | User management, item type config, AI settings |

## Create a program

Programs are the top-level organizational unit. The minimal seed creates a `DEFAULT` program, but you can create your own.

1. Navigate to **Programs** in the sidebar.
2. Click **New Program**.
3. Fill in:
   - **Name**: e.g., `My First Product`
   - **Code**: e.g., `MFP` (short unique identifier)
   - **Description**: optional
4. Click **Create**.

You are automatically added as a Program Admin.

## Create a design

Designs are version containers within a program. Each design has its own `main` branch and supports ECO branches.

1. Navigate to **Designs** in the sidebar.
2. Click **New Design**.
3. Fill in:
   - **Program**: select your program
   - **Name**: e.g., `Widget Assembly`
   - **Code**: e.g., `WIDGET` (unique within the program)
   - **Design Type**: `Product` (or `Library` for shared parts)
4. Click **Create**.

The design is created with an initial `main` branch and commit.

## Create your first part

Parts are the core item type in PLM. They represent physical components, assemblies, or software modules.

1. Navigate to **Parts** in the sidebar.
2. Click **New Part**.
3. Fill in:
   - **Design**: select the design you just created
   - **Name**: e.g., `Widget Housing`
   - **Part Type**: `Manufacture` (options: Manufacture, Purchase, Phantom, Software)
   - **Description**: optional
4. Click **Create**.

The part is created in `Draft` state on the design's `main` branch. An item number is automatically assigned (e.g., `PN-000001`).

### Part types

| Type          | Use for                                                |
| ------------- | ------------------------------------------------------ |
| `Manufacture` | Parts your organization fabricates                     |
| `Purchase`    | Parts bought from suppliers                            |
| `Phantom`     | Logical groupings (not physically built, used in BOMs) |
| `Software`    | Software components tracked alongside hardware         |

## Create your first ECO

Engineering Change Orders (ECOs) are how changes flow through the system. Cascadia uses an "ECO-as-Branch" model: each ECO creates an isolated branch where changes are made, then merged to `main` when approved.

### 1. Create the ECO

1. Navigate to **Change Orders** in the sidebar.
2. Click **New Change Order**.
3. Fill in:
   - **Design**: select your design
   - **Change Type**: `ECO` (options: ECO, ECN, Deviation, MCO, XCO)
   - **Title**: e.g., `Update Widget Housing material`
   - **Description**: describe the change
4. Click **Create**.

The ECO is created in `Draft` state and an ECO branch is created automatically.

### 2. Add affected items

1. Open the ECO you just created.
2. In the **Affected Items** section, click **Add Items**.
3. Search for your part (e.g., `Widget Housing`) and add it.
4. Select the **Change Action** for the item:
   - **Release**: moves item from Draft to Released (first release)
   - **Revise**: creates a new revision of a Released item
   - **Obsolete**: marks a Released item as Obsolete

The item is checked out to the ECO branch, creating an isolated working copy.

### 3. Make changes

While items are checked out to the ECO branch, you can edit them freely without affecting the `main` branch. Other users can work on their own ECOs in parallel.

### 4. Submit and approve

1. On the ECO detail page, click the workflow transition button to **Submit for Review**.
2. The ECO moves to `In Review` state.
3. Click **Approve** to approve the ECO.

When the ECO reaches its final state (Approved), Cascadia automatically:

- Merges the ECO branch changes back to `main`
- Assigns revision letters (A, B, C...) to affected items
- Transitions affected items through their lifecycles (Draft to Released, Released to Superseded, etc.)

## The ECO-as-Branch workflow

This is the core workflow pattern in Cascadia:

```
main ──────────────────────────────────────────── (Released items)
         \                                   /
          └── ECO-001 branch ──────────────┘
              (isolated changes,           (merge on approval,
               parallel work)               assign revisions)
```

Key points:

- **Branch protection**: You cannot modify items on `main` directly. All changes must go through an ECO.
- **Parallel development**: Multiple ECOs can work on different (or even the same) items simultaneously.
- **Revision assignment**: Revision letters are only assigned at merge time, not during work.
- **Conflict detection**: If two ECOs modify the same item, Cascadia detects the conflict during the merge process.

## Database reset

If you want to start fresh at any point:

```bash
npm run db:reset              # Truncate all tables (empty database)
npm run db:reset:seed         # Truncate + re-apply minimal seed
```

> **Important**: Always use these npm scripts rather than running SQL directly. The scripts handle table ordering and cascading truncation correctly.

## Next steps

- **Load the catalog**: Run `npm run db:seed:catalog` to populate the Standard Parts Library with a generic fastener and raw-stock catalog.
- **Upload files**: Attach CAD models or documents to parts via the file vault.
- **Build a BOM**: Add child parts to create a Bill of Materials hierarchy.
- **Try the AI chatbot**: If you have an `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` set, try the AI panel for assisted design.
- **Configure lifecycles**: Visit `/lifecycles` to see the workflow state machines.
- **Manage users**: Visit `/admin` to create additional users and assign roles.

## Further reading

- [Configuration](./configuration.md) -- All environment variables and runtime configuration
- [Installation](./installation.md) -- Full setup and troubleshooting guide
