// Package migrations embeds database migrations into the binary so that a
// single executable can provision an empty PostgreSQL database.
package migrations

import "embed"

// FS contains every .sql migration, applied in lexical filename order.
//
//go:embed *.sql
var FS embed.FS
