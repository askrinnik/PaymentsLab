# Build stage
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

COPY global.json Directory.Build.props ./
COPY Payments.Api/Payments.Api.csproj Payments.Api/
RUN dotnet restore Payments.Api/Payments.Api.csproj

COPY . .
RUN dotnet publish Payments.Api/Payments.Api.csproj -c Release -o /app --no-restore

# Runtime stage
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
COPY --from=build /app .
USER $APP_UID
EXPOSE 8080
ENTRYPOINT ["dotnet", "Payments.Api.dll"]
