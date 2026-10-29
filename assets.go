// Package assets embeds the frontend so that a single Go binary can serve the
// whole application. The source files live under web/; Files is rooted there
// so public URLs stay /app.js, /styles.css and /admin.
package assets

import (
	"embed"
	"fmt"
	"io/fs"
)

//go:embed web
var embedded embed.FS

// Files contains the static frontend rooted at web/.
var Files fs.FS = mustSub()

func mustSub() fs.FS {
	sub, err := fs.Sub(embedded, "web")
	if err != nil {
		panic(fmt.Sprintf("assets: root web directory: %v", err))
	}
	return sub
}
