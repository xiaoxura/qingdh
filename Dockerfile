# syntax=docker/dockerfile:1

# ---- build -----------------------------------------------------------------
FROM golang:1.24-alpine AS build

WORKDIR /src

# Cache module downloads separately from source changes.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

ARG VERSION=dev
RUN CGO_ENABLED=0 GOOS=linux go build \
        -trimpath \
        -ldflags="-s -w -X main.version=${VERSION}" \
        -o /out/qingdh ./cmd/qingdh

# ---- runtime ---------------------------------------------------------------
# distroless/static ships CA certificates (needed for SMTP over TLS) and runs
# as a non-root user by default.
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/qingdh /qingdh

EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/qingdh"]
# Mount the same config.yml you use outside the container.
CMD ["serve", "-config", "/etc/qingdh/config.yml"]
