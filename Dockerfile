FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /erling-open .

FROM gcr.io/distroless/static-debian12
COPY --from=build /erling-open /erling-open
ENV DATA_DIR=/data
EXPOSE 8080
ENTRYPOINT ["/erling-open"]
