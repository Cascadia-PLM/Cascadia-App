import type { DriveStep } from 'driver.js'

export const tourSteps: Array<DriveStep> = [
  // Step 1: Welcome (centered, no element)
  {
    popover: {
      title: 'Welcome to Cascadia PLM',
      description:
        "Let's take a quick tour of the key features to help you get started with your product lifecycle management.",
      side: 'over',
      align: 'center',
    },
  },

  // Step 2: Navigation Sidebar
  {
    element: '[data-testid="main-nav"]',
    popover: {
      title: 'Navigation Sidebar',
      description:
        'This is your main navigation. Access all major sections of the PLM system from here. You can pin it open or collapse it to save space.',
      side: 'right',
      align: 'start',
    },
  },

  // Step 3: Parts
  {
    element: '[data-testid="nav-parts"]',
    popover: {
      title: 'Parts Library',
      description:
        'Manage your parts catalog here. Create, view, and organize mechanical, electrical, and software components with full revision history.',
      side: 'right',
      align: 'start',
    },
  },

  // Step 4: Documents
  {
    element: '[data-testid="nav-documents"]',
    popover: {
      title: 'Document Control',
      description:
        'Store and manage engineering documents with version control. Link documents to parts, requirements, and change orders.',
      side: 'right',
      align: 'start',
    },
  },

  // Step 5: Change Orders (signature feature)
  {
    element: '[data-testid="nav-change-orders"]',
    popover: {
      title: 'Engineering Changes',
      description:
        "This is Cascadia's signature feature: ECO-as-Branch. Each Engineering Change Order creates an isolated branch for parallel development, then merges changes back when approved.",
      side: 'right',
      align: 'start',
    },
  },

  // Step 6: Programs
  {
    element: '[data-testid="nav-programs"]',
    popover: {
      title: 'Programs & Designs',
      description:
        'Organize your work by Programs (permission boundaries) and Designs (version containers). This hierarchy keeps your engineering data structured.',
      side: 'right',
      align: 'start',
    },
  },

  // Step 7: Enterprise Search
  {
    element: '[data-testid="enterprise-search"]',
    popover: {
      title: 'Enterprise Search',
      description:
        'Quickly find any item across the entire system. Search parts, documents, requirements, and change orders. Use Ctrl+K (Cmd+K on Mac) for quick access.',
      side: 'bottom',
      align: 'center',
    },
  },

  // Step 8: Dashboard Stats
  {
    element: '[data-testid="dashboard-stats"]',
    popover: {
      title: 'Dashboard Overview',
      description:
        'Your dashboard shows key metrics at a glance: total parts, designs, requirements, and active change orders. Click any card to dive into that section.',
      side: 'bottom',
      align: 'start',
    },
  },

  // Step 9: Profile Dropdown
  {
    element: '[data-testid="profile-dropdown"]',
    popover: {
      title: 'Your Profile',
      description:
        'Access your profile settings, preferences, and logout from here. You can also switch themes using the toggle nearby.',
      side: 'bottom',
      align: 'end',
    },
  },

  // Step 10: Completion (centered, no element)
  {
    popover: {
      title: "You're Ready!",
      description:
        "That's the basics! Start by exploring the Parts library or creating your first Design. You can restart this tour anytime from the help button in the header.",
      side: 'over',
      align: 'center',
    },
  },
]
