# Build stage
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

COPY global.json Directory.Build.props ./
COPY src/Payments.Api/Payments.Api.csproj src/Payments.Api/
RUN dotnet restore src/Payments.Api/Payments.Api.csproj

COPY src/ src/
RUN dotnet publish src/Payments.Api/Payments.Api.csproj -c Release -o /app --no-restore

# Runtime stage
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
COPY --from=build /app .
USER $APP_UID
EXPOSE 8080
ENTRYPOINT ["dotnet", "Payments.Api.dll"]
