import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { customersTable } from "./customers";
import { customerSitesTable } from "./customer-sites";

/**
 * A Jablotron alarm-system user. Stored as JSON on a device credential because
 * users only exist in the context of their parent credential and are always
 * edited together with it. A user can hold more than one access card.
 */
export type JablotronUser = {
  id: string;
  name: string;
  pin: string | null;
  cards: string[];
};

/** A single port (interface) on a network device. */
export type NetworkPort = {
  id: string;
  portNumber: string;
  name: string;
  connectedDevice: string;
};

/** One physical or virtual device in a local-network topology map. */
export type NetworkDevice = {
  id: string;
  deviceType: string;
  name: string;
  ipAddress: string;
  quantity: number;
  note: string;
  ports: NetworkPort[];
};

export const deviceCredentialsTable = pgTable("device_credentials", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id")
    .notNull()
    .references(() => customersTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => customerSitesTable.id, {
    onDelete: "set null",
  }),
  type: text("type"),
  serialNumber: text("serial_number"),
  ipAddress: text("ip_address"),
  pin: text("pin"),
  username: text("username"),
  password: text("password"),
  email: text("email"),
  note: text("note"),
  users: jsonb("users").$type<JablotronUser[]>().notNull().default([]),
  networkTopology: jsonb("network_topology").$type<NetworkDevice[]>().notNull().default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertDeviceCredentialSchema = createInsertSchema(
  deviceCredentialsTable,
).omit({ id: true, createdAt: true });
export type InsertDeviceCredential = z.infer<typeof insertDeviceCredentialSchema>;
export type DeviceCredential = typeof deviceCredentialsTable.$inferSelect;
