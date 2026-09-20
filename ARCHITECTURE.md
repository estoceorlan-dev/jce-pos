# JCE Dry Goods Trading

## Point-of-Sale and General Merchandise Management System

### System Architecture

---

## 1. System Overview

The **JCE Dry Goods Trading Point-of-Sale and General Merchandise Management System** is a modular business management system designed to support the daily operations of a general merchandise trading business with multiple branches.

The system provides centralized management of:

* Point of Sale (POS)
* Products and Inventory
* Stock Transfers
* Branches
* Users and Roles
* Suppliers
* Customers
* Sales
* Purchases
* Reports
* Dashboard and Analytics
* System Logs and Audit Trails
* Data Synchronization

The system is designed using a **single React-based frontend codebase** that can run as both:

1. **Web Application** — accessed through a web browser.
2. **Desktop Application (.exe)** — packaged using a desktop runtime such as Electron or Tauri.

The backend uses **Node.js** and provides a centralized API layer for business logic, authentication, authorization, reporting, synchronization, and database operations.

The primary database is **PostgreSQL**, with the architecture designed to initially support local/offline operation while remaining scalable for future online synchronization between branches.

---

# 2. High-Level Architecture

```text
                         JCE DRY GOODS TRADING
                         SYSTEM ARCHITECTURE

                              USERS
                                |
              +-----------------+-----------------+
              |                                   |
              v                                   v
       React Web Application             React Desktop Application
          (Browser)                           (.EXE)
              |                                   |
              +-----------------+-----------------+
                                |
                                v
                    +-----------------------+
                    |    Application/API    |
                    |       Layer           |
                    |      Node.js          |
                    +-----------------------+
                                |
        +-----------------------+-----------------------+
        |                       |                       |
        v                       v                       v
 +--------------+       +--------------+       +--------------+
 | Authentication|       | Business     |       | Sync /       |
 | & Authorization|      | Logic        |       | Replication  |
 +--------------+       +--------------+       +--------------+
        |                       |                       |
        +-----------------------+-----------------------+
                                |
                                v
                       +------------------+
                       |    PostgreSQL    |
                       |    Database      |
                       +------------------+
                                |
                +---------------+---------------+
                |                               |
                v                               v
        Local Branch Database             Central/Online
        (Offline Operation)               Database
```

---

# 3. Architectural Approach

The system follows a **modular client-server architecture** with an **offline-first design**.

### Core principles

* Single frontend codebase
* Modular backend
* Centralized business logic
* Role-based access control
* Local database support
* Offline operation
* Online synchronization capability
* Branch-aware data management
* Auditability of important operations
* Scalable database architecture
* API-based communication

The architecture separates the presentation, business logic, data access, and synchronization responsibilities.

---

# 4. Technology Stack

| Layer                | Technology                            |
| -------------------- | ------------------------------------- |
| Frontend             | React.js                              |
| Programming Language | JavaScript / TypeScript               |
| UI                   | React + Tailwind CSS / UI Component Library    |
| Web Application      | React Web                             |
| Desktop Application  | Electron or Tauri                     |
| Backend              | Node.js                               |
| API                  | REST API                              |
| Database             | PostgreSQL                            |
| Local Database       | PostgreSQL                            |
| Authentication       | JWT / Secure Session                  |
| Password Security    | bcrypt / Argon2                       |
| Data Validation      | Backend validation middleware         |
| Database Access      | PostgreSQL Driver / ORM               |
| Logging              | Application + Audit Logging           |
| Synchronization      | Custom Sync Service                   |
| Version Control      | Git                                   |
| Repository Hosting   | GitHub                                |
| Deployment           | Local Server / Cloud Server           |
| Reports              | Backend-generated reports / PDF / CSV |
| Packaging            | Electron Builder / Tauri              |

---

# 5. Frontend Architecture

The frontend is developed using **React** and follows a modular structure.

The same React application is used for both the web and desktop versions.

```text
React Application
│
├── Authentication
│   ├── Login
│   ├── Session Management
│   └── Password Management
│
├── Dashboard
│   ├── Sales Summary
│   ├── Inventory Summary
│   ├── Low Stock Alerts
│   ├── Branch Summary
│   └── Activity Summary
│
├── POS
│   ├── Product Search
│   ├── Cart
│   ├── Discounts
│   ├── Payment
│   ├── Receipt
│   └── Transaction History
│
├── Inventory
│   ├── Products
│   ├── Stock Levels
│   ├── Stock Adjustments
│   ├── Stock History
│   └── Low Stock Monitoring
│
├── Transfers
│   ├── Create Transfer
│   ├── Transfer Requests
│   ├── Transfer Approval
│   ├── Transfer Receiving
│   └── Transfer History
│
├── Purchases
│   ├── Suppliers
│   ├── Purchase Orders
│   ├── Receiving
│   └── Purchase History
│
├── Sales
│   ├── Sales History
│   ├── Returns
│   ├── Voided Transactions
│   └── Sales Details
│
├── Branch Management
│   ├── Branches
│   ├── Branch Settings
│   └── Branch Inventory
│
├── User Management
│   ├── Users
│   ├── Roles
│   └── Permissions
│
├── Reports
│   ├── Sales Reports
│   ├── Inventory Reports
│   ├── Purchase Reports
│   ├── Transfer Reports
│   ├── User Activity Reports
│   └── Financial Summaries
│
├── Logs
│   ├── Audit Logs
│   ├── Login Logs
│   ├── Transaction Logs
│   └── System Logs
│
└── Settings
    ├── Business Settings
    ├── POS Settings
    ├── Tax Settings
    ├── Receipt Settings
    └── Synchronization Settings
```

---

# 6. Backend Architecture

The backend uses **Node.js** and provides a REST API consumed by both the React web application and the desktop application.

```text
Node.js Backend
│
├── API Layer
│   ├── Authentication API
│   ├── User API
│   ├── Branch API
│   ├── Product API
│   ├── Inventory API
│   ├── POS API
│   ├── Sales API
│   ├── Purchase API
│   ├── Transfer API
│   ├── Supplier API
│   ├── Customer API
│   ├── Reports API
│   ├── Dashboard API
│   ├── Logs API
│   └── Synchronization API
│
├── Middleware
│   ├── Authentication
│   ├── Authorization
│   ├── Validation
│   ├── Error Handling
│   ├── Request Logging
│   └── Branch Access Control
│
├── Business Logic
│   ├── POS Service
│   ├── Inventory Service
│   ├── Transfer Service
│   ├── Purchase Service
│   ├── Sales Service
│   ├── User Service
│   ├── Branch Service
│   ├── Report Service
│   └── Synchronization Service
│
├── Data Access Layer
│   ├── User Repository
│   ├── Product Repository
│   ├── Inventory Repository
│   ├── Sales Repository
│   ├── Purchase Repository
│   ├── Transfer Repository
│   └── Audit Repository
│
└── PostgreSQL Database
```

---

# 7. Database Architecture

PostgreSQL is used as the primary relational database.

The database is designed around a **branch-aware data model** so that transactions can be associated with the branch where they occurred.

```text
                         PostgreSQL
                             |
        +--------------------+--------------------+
        |                    |                    |
        v                    v                    v
     Users               Products             Branches
        |                    |                    |
        |                    |                    |
        +--------------------+--------------------+
                             |
                             v
                         Inventory
                             |
          +------------------+------------------+
          |                  |                  |
          v                  v                  v
       Sales             Purchases          Transfers
          |                  |                  |
          +------------------+------------------+
                             |
                             v
                       Audit / Logs
```

---

# 8. Core Database Entities

### User Management

```text
users
roles
permissions
role_permissions
user_roles
user_sessions
```

### Branch Management

```text
branches
branch_settings
branch_users
```

### Product Management

```text
products
product_categories
product_brands
product_units
product_variants
product_prices
```

### Inventory

```text
inventories
inventory_movements
stock_adjustments
stock_adjustment_items
```

### Sales / POS

```text
sales
sale_items
sale_payments
sale_discounts
sales_returns
sales_return_items
```

### Purchasing

```text
suppliers
purchase_orders
purchase_order_items
purchases
purchase_items
```

### Transfers

```text
stock_transfers
stock_transfer_items
transfer_receipts
transfer_receipt_items
```

### Customers

```text
customers
customer_transactions
```

### Logging

```text
audit_logs
login_logs
system_logs
```

### Synchronization

```text
sync_queue
sync_records
sync_conflicts
```

---

# 9. Point-of-Sale Architecture

The POS module is responsible for processing sales transactions.

```text
Cashier
   |
   v
Product Search
   |
   v
Shopping Cart
   |
   +----> Quantity
   |
   +----> Discount
   |
   +----> Customer
   |
   v
Payment
   |
   +----> Cash
   +----> Other Payment Methods
   |
   v
Transaction Validation
   |
   v
Create Sale
   |
   +----> Update Inventory
   |
   +----> Create Inventory Movement
   |
   +----> Create Audit Log
   |
   v
Receipt Generation
```

A POS transaction should be processed as a **database transaction** to prevent partial updates.

For example:

```text
BEGIN TRANSACTION

Create Sale
       ↓
Create Sale Items
       ↓
Deduct Inventory
       ↓
Create Inventory Movement
       ↓
Record Payment
       ↓
Create Audit Log

COMMIT
```

If any critical operation fails:

```text
ROLLBACK
```

This prevents situations where a sale is recorded but the inventory is not deducted.

---

# 10. Inventory Architecture

The inventory module maintains stock quantities for every product and branch.

```text
Product
   |
   v
Branch Inventory
   |
   +---- Current Stock
   |
   +---- Minimum Stock
   |
   +---- Maximum Stock
   |
   +---- Reserved Stock
   |
   v
Inventory Movements
   |
   +---- Sale
   +---- Purchase
   +---- Transfer Out
   +---- Transfer In
   +---- Adjustment
   +---- Return
```

Instead of relying only on the current stock quantity, the system records every stock-changing operation in an **inventory movement ledger**.

Example:

```text
Opening Stock
      +
Purchases
      +
Transfer In
      +
Customer Returns
      -
Sales
      -
Transfer Out
      -
Damaged / Lost Stock
      =
Current Stock
```

This allows the system to maintain an auditable inventory history.

---

# 11. Stock Transfer Architecture

Stock transfers allow products to move between branches.

```text
Source Branch
      |
      v
Create Transfer Request
      |
      v
Transfer Approval
      |
      v
Stock Reserved / Deducted
      |
      v
Transfer In Transit
      |
      v
Destination Branch
      |
      v
Receive Transfer
      |
      v
Destination Inventory Updated
      |
      v
Transfer Completed
```

Example transfer statuses:

```text
DRAFT
PENDING
APPROVED
IN_TRANSIT
RECEIVED
CANCELLED
REJECTED
```

---

# 12. Branch Management

Every branch is treated as an independent operational location while remaining part of the same business.

```text
Company
│
├── Branch A
│   ├── Users
│   ├── POS
│   ├── Inventory
│   └── Transactions
│
├── Branch B
│   ├── Users
│   ├── POS
│   ├── Inventory
│   └── Transactions
│
└── Branch C
    ├── Users
    ├── POS
    ├── Inventory
    └── Transactions
```

Users may be restricted to one or more branches depending on their role.

---

# 13. User Management and Access Control

The system implements **Role-Based Access Control (RBAC)**.

Example roles:

```text
System Administrator
        |
        +---- Full System Access

Owner / Manager
        |
        +---- Reports
        +---- Inventory
        +---- Branches
        +---- Users
        +---- POS
        +---- Transfers

Cashier
        |
        +---- POS
        +---- Sales History
        +---- Customer Management

Inventory Staff
        |
        +---- Inventory
        +---- Transfers
        +---- Receiving

Branch Manager
        |
        +---- Branch Operations
        +---- Inventory
        +---- Reports
        +---- Staff
```

Permissions should be defined separately from roles.

Example permissions:

```text
pos.create_sale
pos.view_sales
pos.refund_sale

inventory.view
inventory.adjust
inventory.receive

transfer.create
transfer.approve
transfer.receive

users.view
users.create
users.update
users.disable

reports.view
reports.export

branches.view
branches.create
branches.update
```

This makes the system easier to expand in the future.

---

# 14. Dashboard Architecture

The dashboard provides a summarized view of business operations.

```text
Dashboard
│
├── Today's Sales
├── Monthly Sales
├── Number of Transactions
├── Average Transaction Value
├── Low Stock Products
├── Out-of-Stock Products
├── Recent Transactions
├── Pending Transfers
├── Pending Purchases
├── Branch Performance
└── Recent System Activities
```

For multi-branch operation:

```text
                 Dashboard
                     |
        +------------+------------+
        |            |            |
        v            v            v
     Branch A     Branch B     Branch C
        |            |            |
      Sales        Sales        Sales
      Stock        Stock        Stock
      Users        Users        Users
```

---

# 15. Reports Module

The reporting system retrieves summarized and detailed information from the database.

### Sales Reports

* Daily Sales
* Weekly Sales
* Monthly Sales
* Sales by Branch
* Sales by Cashier
* Sales by Product
* Sales by Category
* Sales by Payment Method
* Voided Sales
* Returned Sales

### Inventory Reports

* Current Stock
* Low Stock
* Out-of-Stock
* Inventory Valuation
* Stock Movement
* Stock Adjustment
* Damaged Items
* Product Movement

### Purchase Reports

* Purchase Summary
* Purchases by Supplier
* Purchase History
* Receiving Reports

### Transfer Reports

* Transfer History
* Pending Transfers
* Completed Transfers
* Transfers by Branch
* Transfer Movement

### User Reports

* User Activity
* Login History
* POS Transactions by User
* Administrative Actions

Reports should support:

```text
Filter
   ↓
Date Range
   ↓
Branch
   ↓
Category / Product
   ↓
User
   ↓
Generate Report
   ↓
View / Export
```

---

# 16. Audit and Logging Architecture

Important system operations are recorded in an audit trail.

Example:

```text
User
  |
  v
Action
  |
  +---- CREATE
  +---- UPDATE
  +---- DELETE
  +---- LOGIN
  +---- LOGOUT
  +---- SALE
  +---- REFUND
  +---- STOCK ADJUSTMENT
  +---- TRANSFER
  |
  v
Audit Log
```

An audit record may contain:

```text
id
user_id
branch_id
action
module
entity_type
entity_id
old_value
new_value
timestamp
ip_address
device_id
```

Audit logs should generally be append-only and should not be editable by ordinary users.

---

# 17. Offline-First Architecture

The desktop application should be capable of operating even when an internet connection is unavailable.

```text
                 Desktop Application
                         |
                         v
                 Local Node.js API
                         |
                         v
                  Local PostgreSQL
                         |
                         v
                   Local Operations
                         |
              +----------+----------+
              |                     |
              v                     v
        Internet Available     Internet Offline
              |                     |
              v                     v
       Synchronization          Continue Working
              |                     |
              +----------+----------+
                         |
                         v
                  Sync When Online
```

This allows essential branch operations such as POS and inventory management to continue during internet interruptions.

---

# 18. Online Synchronization Architecture

The system is designed so that local branch databases can synchronize with a central online server in the future.

```text
                    CLOUD / CENTRAL SERVER
                             |
                     +-------+-------+
                     |               |
                     v               v
               Central API      Central PostgreSQL
                     |
                     |
       +-------------+-------------+
       |             |             |
       v             v             v
   Branch A       Branch B      Branch C
   Database       Database      Database
       |             |             |
       v             v             v
   Local API      Local API     Local API
```

Each branch can operate locally.

When connectivity is available:

```text
Local Transaction
       |
       v
Local PostgreSQL
       |
       v
Sync Queue
       |
       v
Synchronization Service
       |
       v
Central API
       |
       v
Central PostgreSQL
```

---

# 19. Synchronization Queue

Every locally created or modified record that needs synchronization can be placed in a synchronization queue.

```text
sync_queue

id
entity_type
entity_id
operation
payload
branch_id
created_at
synced_at
status
retry_count
error_message
```

Possible statuses:

```text
PENDING
SYNCING
SYNCED
FAILED
CONFLICT
```

Example:

```text
POS Sale
   |
   v
Local Database
   |
   v
Sync Queue
   |
   v
Internet Available?
   |
   +---- NO ----> Wait
   |
   +---- YES
          |
          v
       Upload
          |
          v
    Central Database
          |
          v
       SYNCED
```

---

# 20. Conflict Handling

Synchronization must account for situations where the same data is changed on different devices or branches.

Examples:

```text
Branch A modifies Product
             +
Branch B modifies same Product
             =
         Conflict
```

The synchronization service should identify conflicts and apply predefined rules.

For inventory, conflicts should generally be resolved through **inventory movements** rather than simply overwriting stock quantities.

Example:

```text
Incorrect:

Branch A Stock = 20
Branch B Stock = 20

Sync → Last Update Wins

```

Preferred approach:

```text
Stock Movement A
      +
Stock Movement B
      |
      v
Central Inventory Ledger
      |
      v
Recalculate Stock
```

This preserves the transaction history and reduces synchronization errors.

---

# 21. API Architecture

The backend exposes RESTful API endpoints.

Example structure:

```text
/api/auth
/api/users
/api/roles
/api/permissions

/api/branches

/api/products
/api/categories
/api/brands

/api/inventory
/api/inventory/movements
/api/inventory/adjustments

/api/pos
/api/sales
/api/sales/returns

/api/purchases
/api/suppliers

/api/transfers

/api/customers

/api/dashboard
/api/reports

/api/logs
/api/audit

/api/sync
```

Example POS request:

```text
POST /api/pos/sales
```

Example inventory request:

```text
GET /api/inventory?branch_id=BRANCH_ID
```

Example transfer request:

```text
POST /api/transfers
```

Example synchronization request:

```text
POST /api/sync/push
GET  /api/sync/pull
```

---

# 22. Security Architecture

The system should implement multiple security layers.

```text
User
 |
 v
Authentication
 |
 v
Session / JWT
 |
 v
Authorization
 |
 v
Role Verification
 |
 v
Permission Verification
 |
 v
Branch Access Verification
 |
 v
Business Logic
 |
 v
Database
```

Security mechanisms include:

* Password hashing
* Secure authentication
* Role-based access control
* Permission-based authorization
* Input validation
* SQL injection protection
* API request validation
* Session management
* Audit logging
* Secure database credentials
* HTTPS for online deployment
* Restricted database access
* Backup and recovery procedures

---

# 23. Desktop Architecture

The desktop version packages the React frontend into a Windows `.exe`.

```text
                JCE Desktop Application
                         (.EXE)
                           |
             +-------------+-------------+
             |                           |
             v                           v
       React Frontend              Desktop Runtime
                                   Electron/Tauri
             |                           |
             +-------------+-------------+
                           |
                           v
                     Local Node.js
                           |
                           v
                    Local PostgreSQL
```

The desktop application may include:

* POS
* Inventory
* Product Management
* Transfers
* Reports
* User Management
* Branch Management
* Offline Operation
* Local Printing
* Receipt Printing

---

# 24. Web Architecture

The web version uses the same React frontend.

```text
User Browser
     |
     v
React Web Application
     |
     v
HTTPS
     |
     v
Node.js API Server
     |
     v
PostgreSQL
```

The web application is intended for:

* Management
* Reports
* Dashboard
* Multi-branch monitoring
* Product management
* User management
* Inventory monitoring
* Online operations

---

# 25. Deployment Architecture

### Initial Local Deployment

For the initial implementation:

```text
                 Branch Computer
                       |
        +--------------+--------------+
        |                             |
        v                             v
 React Desktop Application       Node.js Server
        |                             |
        +--------------+--------------+
                       |
                       v
                PostgreSQL
```

This configuration allows the system to operate within the local branch network.

---

### Future Online Deployment

```text
                    INTERNET
                       |
                       v
                Cloud / VPS
                       |
             +---------+---------+
             |                   |
             v                   v
         Node.js API       PostgreSQL
             |
             |
       +-----+-----+-----+
       |           |     |
       v           v     v
   Branch A    Branch B  Branch C
     Local       Local     Local
     System      System    System
```

---

# 26. Backup Architecture

The system should support regular database backups.

```text
PostgreSQL
    |
    v
Automated Backup
    |
    +---- Daily Backup
    +---- Weekly Backup
    +---- Monthly Backup
    |
    v
Backup Storage
```

Backup strategies should include:

* Scheduled backups
* Database dump
* Backup verification
* Retention policy
* Recovery testing
* Separate backup storage

---

# 27. Recommended Project Structure

### Frontend

```text
frontend/
│
├── src/
│   ├── components/
│   ├── pages/
│   ├── layouts/
│   ├── modules/
│   │   ├── auth/
│   │   ├── dashboard/
│   │   ├── pos/
│   │   ├── inventory/
│   │   ├── transfers/
│   │   ├── purchases/
│   │   ├── sales/
│   │   ├── products/
│   │   ├── branches/
│   │   ├── users/
│   │   ├── reports/
│   │   └── logs/
│   │
│   ├── services/
│   ├── api/
│   ├── hooks/
│   ├── context/
│   ├── utils/
│   ├── routes/
│   └── App.jsx
│
└── package.json
```

### Backend

```text
backend/
│
├── src/
│   ├── controllers/
│   ├── services/
│   ├── repositories/
│   ├── models/
│   ├── routes/
│   ├── middleware/
│   ├── validators/
│   ├── auth/
│   ├── sync/
│   ├── reports/
│   ├── utils/
│   └── app.js
│
├── migrations/
├── seeds/
├── tests/
└── package.json
```

### Desktop

```text
desktop/
│
├── main/
│   ├── main.js
│   ├── ipc/
│   └── services/
│
└── package.json
```

---

# 28. Overall System Flow

```text
                         USER
                          |
                          v
              +-----------------------+
              | React Application     |
              | Web / Desktop         |
              +-----------+-----------+
                          |
                          v
              +-----------------------+
              | Node.js API           |
              | Application Server    |
              +-----------+-----------+
                          |
        +-----------------+------------------+
        |                 |                  |
        v                 v                  v
 Authentication      Business Logic       Sync Service
 Authorization       & Validation         & Queue
        |                 |                  |
        +-----------------+------------------+
                          |
                          v
                +-------------------+
                |    PostgreSQL     |
                +---------+---------+
                          |
             +------------+------------+
             |                         |
             v                         v
       Local Database            Central Database
       / Branch DB               / Cloud DB
             |                         |
             +------------+------------+
                          |
                          v
                    Reports /
                    Dashboard /
                    Analytics
```

---

# 29. Main Functional Modules

The complete system consists of the following major modules:

```text
1. Authentication & Authorization
2. Dashboard
3. Point of Sale
4. Product Management
5. Inventory Management
6. Stock Transfers
7. Purchase Management
8. Supplier Management
9. Customer Management
10. Sales Management
11. Branch Management
12. User Management
13. Role & Permission Management
14. Reports
15. Audit Logs
16. System Logs
17. Synchronization
18. Backup & Recovery
19. System Settings
```

---

# 30. Scalability Considerations

The architecture is designed so that the system can initially operate as a local application while allowing future expansion.

### Initial Stage

```text
React Desktop
      ↓
Node.js
      ↓
Local PostgreSQL
```

### Multi-Computer Local Network

```text
React Desktop Clients
        ↓
 Local Node.js Server
        ↓
 Local PostgreSQL
```

### Multi-Branch

```text
Branch A ── Local PostgreSQL
      \
       \
        → Central API → Central PostgreSQL
       /
      /
Branch B ── Local PostgreSQL
```

### Fully Online

```text
React Web/Desktop
        ↓
Cloud Node.js API
        ↓
Cloud PostgreSQL
```

This progression allows the system to grow without requiring a complete rewrite of the application.

---

# 31. Architectural Summary

The JCE Dry Goods Trading System follows a **modular, offline-first, client-server architecture**.

The React frontend provides a unified interface for both web and desktop environments. Node.js serves as the application and API layer, handling authentication, authorization, business rules, transaction processing, reporting, and synchronization. PostgreSQL serves as the relational database for products, inventory, sales, purchases, branches, users, transfers, and audit records.

The system initially supports **local PostgreSQL deployment** for reliable branch-level operation. A synchronization layer is incorporated into the architecture to enable future **online synchronization between branches and a central database**.

The architecture therefore supports the following progression:

```text
LOCAL
React + Node.js + PostgreSQL
        ↓
LOCAL NETWORK
Multiple React Clients + Node.js + PostgreSQL
        ↓
MULTI-BRANCH
Local Branch Databases + Central Synchronization
        ↓
ONLINE
React Web/Desktop + Cloud Node.js + Cloud PostgreSQL
```

The architecture is designed to provide:

* Reliable POS operations
* Accurate inventory tracking
* Multi-branch management
* Controlled user access
* Comprehensive audit trails
* Business reporting
* Offline functionality
* Future online synchronization
* Maintainability
* Scalability
* Single-codebase frontend development