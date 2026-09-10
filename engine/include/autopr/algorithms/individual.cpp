#include "individual.h"
#include "mapping.h"
#include <algorithm>
#include <cstdlib>
#include <queue>
#include <set>
#include <tuple>

namespace fcngraph {
RegularEvaluation validateRegularCandidate(Parse& parse, GridChessboard& board,
                                           const RegularPlacements& nodes,
                                           const RegularRoutes& routes) {
    RegularEvaluation result;
    const auto fail = [&](const std::string& message) {
        result.error = message;
        return result;
    };
    const auto effectiveNodes = parse.getEffectiveNodes();
    if (nodes.empty() || nodes.size() != effectiveNodes.size()) return fail("incomplete node coverage");
    std::set<position> occupied, used;
    NodeLinkMap links;
    for (auto id : effectiveNodes) {
        const auto found = nodes.find(id);
        if (found == nodes.end()) return fail("missing effective node");
        if (!board.getGridMap().count(found->second)) return fail("node outside clock grid");
        if (!occupied.insert(found->second).second) return fail("overlapping nodes");
        links[{found->second, parse.getNodeType(id)}] = {{}, {}};
    }
    used = occupied;
    std::set<std::pair<unsigned int, unsigned int>> expected;
    for (auto edge : parse.getEffectiveEdges()) expected.insert({edge.first, edge.second});
    for (const auto& route : routes) if (route.second.size() >= 2) ++result.routed_edges;
    if (expected.empty() || routes.size() != expected.size() || result.routed_edges != expected.size())
        return fail("incomplete route coverage");
    std::map<unsigned int, std::set<position>> sinkPorts;
    std::map<position, std::map<unsigned int, std::set<char>>> crossingUses;
    std::map<unsigned int, std::map<position, position>> sourceParents;
    std::map<unsigned int, std::vector<std::pair<unsigned int, unsigned int>>> successors;
    std::map<unsigned int, std::size_t> indegrees;
    for (const auto& node : nodes) indegrees[node.first] = 0;
    std::vector<std::vector<position>> geometry;
    for (const auto& [edge, path] : routes) {
        if (!expected.count(edge) || !nodes.count(edge.first) || !nodes.count(edge.second))
            return fail("unexpected edge or absent endpoint");
        if (path.front() != nodes.at(edge.first) || path.back() != nodes.at(edge.second))
            return fail("route endpoints disagree with placement");
        if (!sinkPorts[edge.second].insert(path[path.size()-2]).second)
            return fail("fanins share a sink port");
        std::set<position> unique;
        for (std::size_t i = 0; i < path.size(); ++i) {
            const auto p = path[i];
            if (!board.getGridMap().count(p)) return fail("route outside clock grid");
            if (!unique.insert(p).second) return fail("route repeats coordinate");
            if (i && i + 1 < path.size() && occupied.count(p)) return fail("route crosses another node");
            if (i) {
                const auto previous = path[i-1];
                if (std::abs(static_cast<long long>(p.first) - previous.first) +
                    std::abs(static_cast<long long>(p.second) - previous.second) != 1)
                    return fail("route is not four-connected");
                const auto directions = board.getPosssibleDirection(previous, true);
                if (std::find(directions.begin(), directions.end(), p) == directions.end())
                    return fail("route violates regular clock direction");
                if ((board.getCoorPos_Phase(p.first, p.second) + 4 -
                     board.getCoorPos_Phase(previous.first, previous.second)) % 4 != 1)
                    return fail("regular clock step must advance exactly one phase");
                auto& parents = sourceParents[edge.first];
                const auto old = parents.find(p);
                if (old != parents.end() && old->second != previous)
                    return fail("same-source routes diverge and rejoin");
                parents[p] = previous;
            }
            if (i && i + 1 < path.size()) {
                const auto previous = path[i-1], next = path[i+1];
                const char orientation = previous.second == p.second && next.second == p.second ? 'H' :
                    (previous.first == p.first && next.first == p.first ? 'V' : 'B');
                crossingUses[p][edge.first].insert(orientation);
            }
            used.insert(p);
        }
        links[{path.front(), parse.getNodeType(edge.first)}].second.push_back(path[1]);
        links[{path.back(), parse.getNodeType(edge.second)}].first.push_back(path[path.size()-2]);
        successors[edge.first].push_back({edge.second, static_cast<unsigned int>(path.size()-1)});
        ++indegrees[edge.second];
        geometry.push_back(path);
    }
    std::set<std::pair<unsigned int, unsigned int>> crossedPairs;
    for (const auto& [point, uses] : crossingUses) {
        if (uses.size() < 2) continue;
        if (uses.size() != 2) return fail("more than two source trees share crossing");
        auto first = uses.begin(), second = std::next(first);
        if (!((first->second == std::set<char>{'H'} && second->second == std::set<char>{'V'}) ||
              (first->second == std::set<char>{'V'} && second->second == std::set<char>{'H'})))
            return fail("different sources overlap without straight H/V crossing");
        if (!crossedPairs.insert({first->first, second->first}).second)
            return fail("source-tree pair crosses more than once");
    }
    // All primary inputs launch one vector in clock cycle zero, at their
    // template phase. Reconvergent fanins must reach the same absolute tick;
    // equal phase modulo four alone cannot establish synchronization.
    std::queue<unsigned int> ready;
    for (const auto& [id, degree] : indegrees) if (!degree) {
        if (parse.getNodeType(id) != "input") return fail("non-input node has no driver");
        ready.push(id);
        const auto p = nodes.at(id);
        result.arrival_ticks[id] = board.getCoorPos_Phase(p.first, p.second) - 1;
    }
    std::size_t visited = 0;
    while (!ready.empty()) {
        const auto source = ready.front(); ready.pop(); ++visited;
        for (auto [target, distance] : successors[source]) {
            const auto arrival = result.arrival_ticks.at(source) + distance;
            const auto old = result.arrival_ticks.find(target);
            if (old != result.arrival_ticks.end() && old->second != arrival)
                return fail("reconvergent fanins arrive in different clock epochs");
            result.arrival_ticks[target] = arrival;
            if (--indegrees[target] == 0) ready.push(target);
        }
    }
    if (visited != nodes.size()) return fail("combinational topology contains a cycle");
    try {
        for (auto& [node, ports] : links) for (auto* port : {&ports.first, &ports.second}) {
            std::sort(port->begin(), port->end());
            port->erase(std::unique(port->begin(), port->end()), port->end());
        }
        Mapping mapping;
        mapping.node_mapping(links, MappingMode::Combinational);
        mapping.mapping_line(geometry, MappingMode::Combinational);
        std::string error;
        if (!mapping.validate_crossovers(&error)) return fail("device crossover mapping: " + error);
        const auto physicalRoutes = mapping.orderedPhysicalRoutes(geometry);
        if (physicalRoutes.size() != geometry.size()) return fail("incomplete physical route coverage");
        for (std::size_t routeIndex=0; routeIndex<physicalRoutes.size(); ++routeIndex) {
            const auto& path=physicalRoutes[routeIndex];
            unsigned int advances=0;
            for (std::size_t i=1; i<path.size(); ++i) {
                const position previous{path[i-1].first/5,path[i-1].second/5};
                const position current{path[i].first/5,path[i].second/5};
                if (previous==current) continue;
                if (!board.getGridMap().count(previous) || !board.getGridMap().count(current))
                    return fail("physical route outside regular clock template");
                if ((board.getCoorPos_Phase(current.first,current.second)+4-
                     board.getCoorPos_Phase(previous.first,previous.second))%4!=1)
                    return fail("device route violates regular phase progression");
                ++advances;
            }
            if (advances!=geometry[routeIndex].size()-1)
                return fail("device mapping changed synchronized route latency");
        }
        const auto physical = mapping.physicalCellSites(geometry);
        if (physical.empty()) return fail("device mapping emitted no cells");
        result.mapped_cells = physical.size();
        unsigned int minX = std::numeric_limits<unsigned int>::max(), minY = minX, maxX = 0, maxY = 0;
        for (auto cell : physical) {
            minX = std::min(minX, cell.xy.first); minY = std::min(minY, cell.xy.second);
            maxX = std::max(maxX, cell.xy.first); maxY = std::max(maxY, cell.xy.second);
        }
        result.physical_area = static_cast<std::size_t>(maxX-minX+1) * (maxY-minY+1);
        minX = std::numeric_limits<unsigned int>::max(); minY = minX; maxX = maxY = 0;
        for (auto p : used) {
            minX = std::min(minX,p.first); minY = std::min(minY,p.second);
            maxX = std::max(maxX,p.first); maxY = std::max(maxY,p.second);
        }
        result.tile_area = static_cast<std::size_t>(maxX-minX+1) * (maxY-minY+1);
        result.routed_tiles = used.size();
        result.valid = true;
    } catch (const std::exception& error) {
        return fail(std::string("device gate/wire mapping: ") + error.what());
    }
    return result;
}

void Individual::computeFitness(Parse& parse, GridChessboard& board, Astar& router,
                                std::chrono::steady_clock::time_point deadline) {
    board.reset(); router.reset(); routes.clear(); evaluation = {};
    std::set<position> used;
    for (const auto& node : nodeindex_pos) {
        if (!board.getGridMap().count(node.second) || !used.insert(node.second).second) {
            evaluation.error = "invalid placement"; return;
        }
        board.placeNode(node.second);
    }
    for (auto edge : parse.getEffectiveEdges()) {
        if (std::chrono::steady_clock::now() >= deadline) {
            evaluation.error = "search budget exhausted"; return;
        }
        const auto type = parse.getNodeType(edge.first);
        routes[{edge.first, edge.second}] = router.findPath(nodeindex_pos.at(edge.first), nodeindex_pos.at(edge.second),
            type == "and" || type == "or" || type == "maj");
    }
    evaluation = validateRegularCandidate(parse, board, nodeindex_pos, routes);
}

bool Individual::betterThan(const Individual& other) const {
    if (evaluation.valid != other.evaluation.valid) return evaluation.valid;
    if (!evaluation.valid) return evaluation.routed_edges > other.evaluation.routed_edges;
    return std::tie(evaluation.physical_area, evaluation.mapped_cells, evaluation.routed_tiles) <
           std::tie(other.evaluation.physical_area, other.evaluation.mapped_cells, other.evaluation.routed_tiles);
}
}
