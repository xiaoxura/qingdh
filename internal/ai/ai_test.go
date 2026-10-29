package ai

import "testing"

func TestNormalizeModelAllowAny(t *testing.T) {
	provider := Provider{
		DefaultModel:  "deepseek-chat",
		Models:        map[string]bool{"deepseek-chat": true},
		AllowAnyModel: true,
	}
	if got, err := provider.NormalizeModel("deepseek-flash"); err != nil || got != "deepseek-flash" {
		t.Fatalf("allow-any model = %q, %v", got, err)
	}
	if got, err := provider.NormalizeModel(""); err != nil || got != "deepseek-chat" {
		t.Fatalf("default model = %q, %v", got, err)
	}
	for _, invalid := range []string{"../evil", "bad model", "deepseek/<script>"} {
		if _, err := provider.NormalizeModel(invalid); err == nil {
			t.Fatalf("expected invalid model %q to be rejected", invalid)
		}
	}

	strict := Provider{DefaultModel: "known", Models: map[string]bool{"known": true}}
	if _, err := strict.NormalizeModel("other"); err == nil {
		t.Fatal("strict provider accepted an unknown model")
	}
}
